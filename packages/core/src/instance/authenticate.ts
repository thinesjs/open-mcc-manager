import { randomUUID } from "node:crypto"
import type { AuthenticationState, DeviceCodeChallenge } from "@open-mcc/contracts"
import type { HostTransport } from "@open-mcc/transport"
import { type HostProfile, profileFrom, systemctl } from "../host/profile"
import {
	type ActorContext,
	InstanceAuthInProgressError,
	type InstanceControllerDeps,
	InstanceHostNotFoundError,
	InstanceNotFoundError,
} from "./instance.controller"
import { instanceDir, unitName, validateInstanceId } from "./unit"

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
		expiresAt: new Date(Date.now() + DEVICE_CODE_TTL_MS),
	}
}

export type AuthPolling = {
	attempts: number
	intervalMs: number
}

export const authUnitName = (instanceId: string): string =>
	`open-mcc-auth@${validateInstanceId(instanceId)}.service`

export const startAuthCommand = (profile: HostProfile, instanceId: string): string => {
	const log = `${instanceDir(profile.instancesRoot, instanceId)}/auth.log`
	const unit = shellQuote(authUnitName(instanceId))
	return `rm -f ${shellQuote(log)} && ${systemctl(profile, `start ${unit}`)}`
}

export const stopAuthCommand = (profile: HostProfile, instanceId: string): string => {
	const unit = shellQuote(authUnitName(instanceId))
	return `${systemctl(profile, `stop ${unit}`)} || true; ${systemctl(
		profile,
		`reset-failed ${unit}`,
	)} || true`
}

const requireProfile = (host: {
	mode: HostProfile["mode"]
	instancesRoot: string | null
	unitDir: string | null
}): HostProfile => {
	if (!host.instancesRoot || !host.unitDir) {
		throw new InstanceHostNotFoundError(
			"Host has not finished provisioning, so its layout is unknown",
		)
	}
	return profileFrom(host.mode, host.instancesRoot, host.unitDir)
}

const stopAuthSession = async (
	transport: HostTransport,
	profile: HostProfile,
	instanceId: string,
): Promise<void> => {
	await transport.exec(stopAuthCommand(profile, instanceId), AUTH_SESSION_TIMEOUT_MS)
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

	const profile = requireProfile(host)
	const transport = deps.createTransport()
	try {
		await transport.connect({
			hostname: host.hostname,
			port: host.port,
			username: host.username,
			privateKey: deps.secrets.open(key.privateKeyEncrypted, key.privateKeyKeyId),
			expectedFingerprint: host.hostKeyFingerprint,
			timeoutMs: AUTH_SESSION_TIMEOUT_MS,
		})

		await transport.exec(
			`${systemctl(profile, `stop ${shellQuote(unitName(instance.id))}`)} || true`,
			AUTH_SESSION_TIMEOUT_MS,
		)

		const dir = instanceDir(profile.instancesRoot, instance.id)
		const log = `${dir}/auth.log`

		await stopAuthSession(transport, profile, instance.id)

		await transport.exec(startAuthCommand(profile, instance.id), AUTH_SESSION_TIMEOUT_MS)

		for (let attempt = 0; attempt < polling.attempts; attempt += 1) {
			const read = await transport.exec(
				`cat ${shellQuote(log)} 2>/dev/null || true`,
				AUTH_SESSION_TIMEOUT_MS,
			)
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
		await stopAuthSession(transport, profile, instance.id).catch(() => undefined)
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

	const profile = requireProfile(host)
	const dir = instanceDir(profile.instancesRoot, instance.id)
	const transport = deps.createTransport()
	try {
		await transport.connect({
			hostname: host.hostname,
			port: host.port,
			username: host.username,
			privateKey: deps.secrets.open(key.privateKeyEncrypted, key.privateKeyKeyId),
			expectedFingerprint: host.hostKeyFingerprint,
			timeoutMs: AUTH_SESSION_TIMEOUT_MS,
		})

		const probe = await transport.exec(
			SESSION_CACHE_FILES.map((name) => `test -s ${shellQuote(`${dir}/${name}`)}`).join(" || "),
			AUTH_SESSION_TIMEOUT_MS,
		)
		if (probe.exitCode !== 0) return { authenticated: false, status: instance.status }

		await stopAuthSession(transport, profile, instance.id)
		await transport.exec(`rm -f ${shellQuote(`${dir}/auth.log`)}`, AUTH_SESSION_TIMEOUT_MS)
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
