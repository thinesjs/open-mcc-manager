import { randomUUID } from "node:crypto"
import {
	type AuthenticationState,
	type DeviceCodeChallenge,
	needsInteractiveSignIn,
} from "@open-mcc/contracts"
import type { HostRow } from "@open-mcc/db"
import type { HostTransport } from "@open-mcc/transport"
import { systemctl } from "../host/profile"
import { COULD_NOT_CONNECT, connectFailureReason } from "../host/unreachable"
import {
	type ActorContext,
	HostUnreachableError,
	InstanceAccountNotInteractiveError,
	InstanceAuthInProgressError,
	type InstanceControllerDeps,
	InstanceHostNotFoundError,
	InstanceNotFoundError,
} from "./instance.controller"
import { UNIT_STOP_TIMEOUT_MS } from "./removal"
import { authUnitName, instanceDir, stopAuthCommand, unitName } from "./unit"

const connectForSignIn = async (
	transport: HostTransport,
	options: Parameters<HostTransport["connect"]>[0],
): Promise<void> => {
	try {
		await transport.connect(options)
	} catch (error) {
		throw new HostUnreachableError(
			error instanceof Error ? connectFailureReason(error) : COULD_NOT_CONNECT,
		)
	}
}

export const DEVICE_CODE_PATTERN = /enter the code:?\s*([A-Z0-9]{4,6}-?[A-Z0-9]{4,6})\b/i

export const VERIFICATION_URI_PATTERN = /(https:\/\/[A-Za-z0-9.\-/]*microsoft\.com\/link)/

export const AUTH_SESSION_TIMEOUT_MS = 30_000

export const DEVICE_CODE_POLL_ATTEMPTS = 10

export const DEVICE_CODE_POLL_INTERVAL_MS = 2_000

export const DEVICE_CODE_TTL_MS = 15 * 60 * 1000

export const SESSION_CACHE_FILES = ["SessionCache.db", "SessionCache.ini"] as const

const shellQuote = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`

const extractChallenge = (output: string): DeviceCodeChallenge | undefined => {
	const code = DEVICE_CODE_PATTERN.exec(output)
	const uri = VERIFICATION_URI_PATTERN.exec(output)
	const userCode = code?.[1]
	const verificationUri = uri?.[1]
	if (userCode === undefined || verificationUri === undefined) return undefined
	return {
		userCode,
		verificationUri,
		expiresAt: new Date(Date.now() + DEVICE_CODE_TTL_MS).toISOString(),
	}
}

export type AuthPolling = {
	attempts: number
	intervalMs: number
}

export const startAuthCommand = (instanceId: string): string => {
	const unit = shellQuote(authUnitName(instanceId))
	return `rm -f ${instanceDir(instanceId)}/auth.log && ${systemctl(`start ${unit}`)}`
}

const requireSetUpOnce = (host: Pick<HostRow, "osRelease">): void => {
	if (host.osRelease === null) {
		throw new InstanceHostNotFoundError("Host has never finished provisioning")
	}
}

const stopAuthSession = async (transport: HostTransport, instanceId: string): Promise<void> => {
	await transport.exec(stopAuthCommand(instanceId), AUTH_SESSION_TIMEOUT_MS)
}

export const beginAuthentication = async (
	deps: InstanceControllerDeps,
	ctx: ActorContext,
	instanceId: string,
	polling: AuthPolling = {
		attempts: DEVICE_CODE_POLL_ATTEMPTS,
		intervalMs: DEVICE_CODE_POLL_INTERVAL_MS,
	},
): Promise<DeviceCodeChallenge> => {
	const scope = { organizationId: ctx.organizationId }

	const instance = await deps.instances.findById(scope, instanceId)
	if (!instance) throw new InstanceNotFoundError(`Instance not found: ${instanceId}`)
	if (!needsInteractiveSignIn(instance.accountType)) {
		throw new InstanceAccountNotInteractiveError(
			`Instance ${instanceId} uses a ${instance.accountType} account, which signs in without a device code`,
		)
	}

	const attemptId = randomUUID()
	const claimed = await deps.instances.claimForAuth(scope, instanceId, attemptId)
	if (!claimed) {
		throw new InstanceAuthInProgressError(
			`Instance ${instanceId} is already being authenticated; the claim has not gone stale`,
		)
	}

	const host = await deps.hosts.findById(scope, instance.hostId)
	if (!host?.sshKeyId || !host.hostKeyFingerprint) {
		await deps.instances.releaseAuthClaim(scope, instanceId, attemptId)
		throw new InstanceHostNotFoundError(`Host ${instance.hostId} is not ready for authentication`)
	}
	const key = await deps.sshKeys.findById(scope, host.sshKeyId)
	if (!key) {
		await deps.instances.releaseAuthClaim(scope, instanceId, attemptId)
		throw new InstanceHostNotFoundError(`Ssh key not found for host ${instance.hostId}`)
	}

	requireSetUpOnce(host)
	const transport = deps.createTransport()
	try {
		await connectForSignIn(transport, {
			hostname: host.hostname,
			port: host.port,
			username: host.username,
			privateKey: deps.secrets.open(key.privateKeyEncrypted, key.privateKeyKeyId),
			expectedFingerprint: host.hostKeyFingerprint,
			timeoutMs: AUTH_SESSION_TIMEOUT_MS,
		})

		await transport.exec(
			`${systemctl(`stop ${shellQuote(unitName(instance.id))}`)} || true`,
			UNIT_STOP_TIMEOUT_MS,
		)

		const log = `${instanceDir(instance.id)}/auth.log`

		await stopAuthSession(transport, instance.id)

		await transport.exec(startAuthCommand(instance.id), AUTH_SESSION_TIMEOUT_MS)

		for (let attempt = 0; attempt < polling.attempts; attempt += 1) {
			const read = await transport.exec(`cat ${log} 2>/dev/null || true`, AUTH_SESSION_TIMEOUT_MS)
			const challenge = extractChallenge(read.stdout)
			if (challenge) {
				await deps.withTransaction(async (repos) => {
					await repos.instances.update(scope, instanceId, { status: "needs_auth" })
					await repos.audit.record(scope, {
						actorId: ctx.memberId,
						actorLabel: ctx.actorLabel,
						action: "instance.authenticate",
						subjectType: "instance",
						subjectId: instanceId,
						detail: { minecraftAccount: instance.minecraftAccount },
					})
				})
				return challenge
			}
			if (attempt + 1 < polling.attempts) {
				await new Promise((resolve) => setTimeout(resolve, polling.intervalMs))
			}
		}

		throw new Error(
			`The client did not present a device code for instance ${instanceId} within the polling window`,
		)
	} catch (error) {
		await stopAuthSession(transport, instance.id).catch(() => undefined)
		await deps.instances.releaseAuthClaim(scope, instanceId, attemptId)
		throw error
	} finally {
		await transport.close().catch(() => undefined)
	}
}

export const completeAuthentication = async (
	deps: InstanceControllerDeps,
	ctx: ActorContext,
	instanceId: string,
): Promise<AuthenticationState> => {
	const scope = { organizationId: ctx.organizationId }

	const instance = await deps.instances.findById(scope, instanceId)
	if (!instance) throw new InstanceNotFoundError(`Instance not found: ${instanceId}`)
	if (instance.status !== "needs_auth") {
		return { authenticated: instance.status !== "created", status: instance.status }
	}

	const host = await deps.hosts.findById(scope, instance.hostId)
	if (!host?.sshKeyId || !host.hostKeyFingerprint) {
		throw new InstanceHostNotFoundError(`Host ${instance.hostId} is not ready for authentication`)
	}
	const key = await deps.sshKeys.findById(scope, host.sshKeyId)
	if (!key) throw new InstanceHostNotFoundError(`Ssh key not found for host ${instance.hostId}`)

	requireSetUpOnce(host)
	const dir = instanceDir(instance.id)
	const transport = deps.createTransport()
	try {
		await connectForSignIn(transport, {
			hostname: host.hostname,
			port: host.port,
			username: host.username,
			privateKey: deps.secrets.open(key.privateKeyEncrypted, key.privateKeyKeyId),
			expectedFingerprint: host.hostKeyFingerprint,
			timeoutMs: AUTH_SESSION_TIMEOUT_MS,
		})

		const probe = await transport.exec(
			SESSION_CACHE_FILES.map((name) => `test -s ${dir}/${name}`).join(" || "),
			AUTH_SESSION_TIMEOUT_MS,
		)
		if (probe.exitCode !== 0) return { authenticated: false, status: instance.status }

		await stopAuthSession(transport, instance.id)
		await transport.exec(`rm -f ${dir}/auth.log`, AUTH_SESSION_TIMEOUT_MS)
	} finally {
		await transport.close().catch(() => undefined)
	}

	await deps.withTransaction(async (repos) => {
		await repos.instances.update(scope, instanceId, { status: "stopped" })
		await repos.audit.record(scope, {
			actorId: ctx.memberId,
			actorLabel: ctx.actorLabel,
			action: "instance.authenticate",
			subjectType: "instance",
			subjectId: instanceId,
			detail: { minecraftAccount: instance.minecraftAccount, phase: "complete" },
		})
	})

	if (instance.authClaimId !== null) {
		await deps.instances.releaseAuthClaim(scope, instanceId, instance.authClaimId)
	}

	return { authenticated: true, status: "stopped" }
}

export const cancelAuthentication = async (
	deps: InstanceControllerDeps,
	ctx: ActorContext,
	instanceId: string,
): Promise<AuthenticationState> => {
	const scope = { organizationId: ctx.organizationId }

	const instance = await deps.instances.findById(scope, instanceId)
	if (!instance) throw new InstanceNotFoundError(`Instance not found: ${instanceId}`)
	if (!needsInteractiveSignIn(instance.accountType)) {
		throw new InstanceAccountNotInteractiveError(
			`Instance ${instanceId} uses a ${instance.accountType} account, which has no sign-in to cancel`,
		)
	}

	const host = await deps.hosts.findById(scope, instance.hostId)
	if (!host?.sshKeyId || !host.hostKeyFingerprint) {
		throw new InstanceHostNotFoundError(`Host ${instance.hostId} is not ready for authentication`)
	}
	const key = await deps.sshKeys.findById(scope, host.sshKeyId)
	if (!key) throw new InstanceHostNotFoundError(`Ssh key not found for host ${instance.hostId}`)

	requireSetUpOnce(host)
	const transport = deps.createTransport()
	try {
		await connectForSignIn(transport, {
			hostname: host.hostname,
			port: host.port,
			username: host.username,
			privateKey: deps.secrets.open(key.privateKeyEncrypted, key.privateKeyKeyId),
			expectedFingerprint: host.hostKeyFingerprint,
			timeoutMs: AUTH_SESSION_TIMEOUT_MS,
		})
		await stopAuthSession(transport, instance.id)
		await transport.exec(`rm -f ${instanceDir(instance.id)}/auth.log`, AUTH_SESSION_TIMEOUT_MS)
	} finally {
		await transport.close().catch(() => undefined)
	}

	if (instance.authClaimId !== null) {
		await deps.instances.releaseAuthClaim(scope, instanceId, instance.authClaimId)
	}

	await deps.withTransaction(async (repos) => {
		await repos.audit.record(scope, {
			actorId: ctx.memberId,
			actorLabel: ctx.actorLabel,
			action: "instance.authenticate",
			subjectType: "instance",
			subjectId: instanceId,
			detail: { minecraftAccount: instance.minecraftAccount, phase: "cancelled" },
		})
	})

	return { authenticated: false, status: instance.status }
}
