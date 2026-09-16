import { randomUUID } from "node:crypto"
import { createSecretStore, generateKeyPair } from "../../packages/core/src/crypto/sealed-box"
import type { ProvisionResult } from "../../packages/core/src/host/provision"
import {
	type ActorContext,
	createInstanceController,
	type InstanceControllerDeps,
} from "../../packages/core/src/instance/instance.controller"
import {
	CONFIG_CLAIM_LEASE_MS,
	isAuthClaimStale,
} from "../../packages/core/src/instance/instance.repository"
import type {
	HostRow,
	InstanceConfigRow,
	InstanceRow,
	InstanceScheduleRow,
} from "../../packages/db/src/index"
import {
	createReadConnections,
	READ_CONNECTION_CHANNEL_LIMIT,
	READ_CONNECTION_HARD_AGE_MS,
	READ_CONNECTION_IDLE_MS,
} from "../../packages/transport/src/read-connections"
import type { ReusableTransport } from "../../packages/transport/src/types"
import { ACCOUNT, HOME } from "./podman-account"
import { type As, shell, succeeded } from "./sandbox"

const FILES = `${HOME}/.local/share/open-mcc`

export const ORGANIZATION = "org-sandbox"

export const HOST_ID = "host-sandbox"

export const owner: ActorContext = {
	organizationId: ORGANIZATION,
	memberId: "member-sandbox",
	actorLabel: "sandbox@example.com",
	role: "owner",
}

export const STAND_IN_CLIENT = [
	"#!/opt/mcc/busybox sh",
	'echo "stand-in client started"',
	"while IFS= read -r line; do",
	'\techo "stand-in client read: $line"',
	'\tcase "$line" in',
	"\t\t/quit) exit 0 ;;",
	"\t\t/fail) exit 3 ;;",
	"\tesac",
	"done",
	"",
].join("\n")

export const installStandInClient = async (host: string, as: As): Promise<void> => {
	succeeded(
		await shell(
			host,
			{ ...as, input: STAND_IN_CLIENT },
			'cp "$(command -v busybox)" "$1/busybox" && cat > "$1/MinecraftClient.stand-in" && chmod 0755 "$1/busybox" "$1/MinecraftClient.stand-in" && mv -f "$1/MinecraftClient.stand-in" "$1/MinecraftClient"',
			`${FILES}/bin`,
		),
		"installing the stand-in client",
	)
}

export const memoryManager = async (
	provisioned: ProvisionResult,
	transport: () => ReusableTransport,
) => {
	const secrets = await createSecretStore(await generateKeyPair("sandbox"))
	const sealed = secrets.seal("a key the sandbox's shell transport never presents")
	const hostRow: HostRow = {
		id: HOST_ID,
		organizationId: ORGANIZATION,
		name: "sandbox",
		hostname: "127.0.0.1",
		port: 22,
		username: ACCOUNT,
		networkStack: provisioned.networkStack,
		architecture: provisioned.architecture,
		osId: provisioned.osId,
		osName: provisioned.osName,
		failedUnits: null,
		teardownError: null,
		teardownRequestedAt: null,
		sshKeyId: "key-sandbox",
		hostKeyAlgorithm: "ssh-ed25519",
		hostKeyFingerprint: "SHA256:sandbox",
		hostKeyTrustedBy: null,
		hostKeyTrustedByLabel: "sandbox",
		hostKeyTrustedAt: new Date(),
		status: "ready",
		osRelease: provisioned.osRelease,
		cpuCount: null,
		memoryMb: null,
		lastSeenAt: null,
		provisioningAttemptId: null,
		provisioningClaimedAt: null,
		provisioningStep: null,
		provisioningStepIndex: null,
		provisioningStepTotal: null,
		provisioningError: null,
		createdAt: new Date(),
	}
	const rows = new Map<string, InstanceRow>()
	const configs: InstanceConfigRow[] = []
	const windows = new Map<string, InstanceScheduleRow>()

	const configClaimIsLive = (row: InstanceRow): boolean =>
		row.configClaimId !== null &&
		row.configClaimedAt !== null &&
		Date.now() - row.configClaimedAt.getTime() < CONFIG_CLAIM_LEASE_MS

	const takeConfigClaim = (id: string, claimId: string): InstanceRow | undefined => {
		const current = rows.get(id)
		if (current === undefined) return undefined
		if (configClaimIsLive(current)) return undefined
		const next = { ...current, configClaimId: claimId, configClaimedAt: new Date() }
		rows.set(id, next)
		return next
	}

	const rowUnderClaim = (id: string, claimId: string): InstanceRow | undefined => {
		const current = rows.get(id)
		return current?.configClaimId === claimId ? current : undefined
	}

	const instances: InstanceControllerDeps["instances"] = {
		insert: async (_scope, values, claimId) => {
			const row: InstanceRow = {
				id: `bot${randomUUID().slice(0, 8)}`,
				organizationId: ORGANIZATION,
				hostId: values.hostId,
				name: values.name,
				accountType: values.accountType ?? "microsoft",
				minecraftAccount: values.minecraftAccount,
				minecraftUsername: values.minecraftUsername ?? null,
				status: values.status ?? "created",
				lastExitCode: values.lastExitCode ?? null,
				liveControlPort: values.liveControlPort,
				liveControlTokenEncrypted: values.liveControlTokenEncrypted ?? null,
				liveControlTokenKeyId: values.liveControlTokenKeyId ?? null,
				authClaimId: null,
				authClaimedAt: null,
				configClaimId: claimId,
				configClaimedAt: new Date(),
				playerListOffset: "0",
				playerListFingerprint: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
				playerListCursorVersion: "0",
				createdAt: new Date(),
			}
			rows.set(row.id, row)
			return row
		},
		findById: async (_scope, id) => rows.get(id),
		list: async () => [...rows.values()],
		update: async (_scope, id, patch) => {
			const current = rows.get(id)
			if (current === undefined) return undefined
			const next = { ...current, ...patch }
			rows.set(id, next)
			return next
		},
		delete: async (_scope, id) => rows.delete(id),
		claimForAuth: async (_scope, id, attemptId) => {
			const current = rows.get(id)
			if (current === undefined) return undefined
			if (configClaimIsLive(current)) return undefined
			const next = {
				...current,
				authClaimId: attemptId,
				authClaimedAt: new Date(),
				configClaimId: null,
				configClaimedAt: null,
			}
			rows.set(id, next)
			return next
		},
		releaseAuthClaim: async (_scope, id) => {
			const current = rows.get(id)
			if (current === undefined) return false
			rows.set(id, { ...current, authClaimId: null, authClaimedAt: null })
			return true
		},
		claimForConfig: async (_scope, id, claimId) => takeConfigClaim(id, claimId),
		claimForLifecycle: async (_scope, id, claimId) => {
			const current = rows.get(id)
			if (current === undefined) return undefined
			if (current.authClaimId !== null && !isAuthClaimStale(current.authClaimedAt)) return undefined
			return takeConfigClaim(id, claimId)
		},
		finalizeConfigClaim: async (_scope, id, claimId, patch) => {
			const current = rowUnderClaim(id, claimId)
			if (current === undefined) return undefined
			const next = {
				...current,
				...(patch.status !== undefined && { status: patch.status }),
				configClaimId: null,
				configClaimedAt: null,
			}
			rows.set(id, next)
			return next
		},
		releaseConfigClaim: async (_scope, id, claimId) => {
			const current = rowUnderClaim(id, claimId)
			if (current === undefined) return false
			rows.set(id, { ...current, configClaimId: null, configClaimedAt: null })
			return true
		},
		writeTokenUnderClaim: async (_scope, id, claimId, sealed) => {
			const current = rowUnderClaim(id, claimId)
			if (current === undefined) return false
			rows.set(id, {
				...current,
				liveControlTokenEncrypted: sealed.ciphertext,
				liveControlTokenKeyId: sealed.keyId,
				configClaimedAt: new Date(),
			})
			return true
		},
		deleteUnderClaim: async (_scope, id, claimId) =>
			rowUnderClaim(id, claimId) !== undefined && rows.delete(id),
		insertConfigVersion: async (_scope, instanceId, document, author) => {
			const row: InstanceConfigRow = {
				id: randomUUID(),
				organizationId: ORGANIZATION,
				instanceId,
				version: configs.filter((each) => each.instanceId === instanceId).length + 1,
				document: JSON.parse(document),
				authorId: author.authorId,
				authorLabel: author.authorLabel,
				createdAt: new Date(),
			}
			configs.push(row)
			return row
		},
		latestConfig: async (_scope, instanceId) =>
			configs.filter((each) => each.instanceId === instanceId).at(-1),
	}

	const schedules: InstanceControllerDeps["schedules"] = {
		upsert: async (_scope, values) => {
			const row: InstanceScheduleRow = {
				id: randomUUID(),
				organizationId: ORGANIZATION,
				createdAt: new Date(),
				...values,
			}
			windows.set(values.instanceId, row)
			return row
		},
		findByInstance: async (_scope, instanceId) => windows.get(instanceId),
		list: async () => [...windows.values()],
		delete: async (_scope, instanceId) => windows.delete(instanceId),
	}

	const commands: InstanceControllerDeps["commands"] = {
		upsert: async (_scope, values) => ({
			id: randomUUID(),
			organizationId: ORGANIZATION,
			lastRunAt: null,
			lastRunError: null,
			createdAt: new Date(),
			...values,
		}),
		listForInstance: async () => [],
		listEnabledAcrossOrganizations: async () => [],
		deleteReturning: async () => undefined,
		delete: async () => false,
		claimRun: async () => true,
		recordRun: async () => undefined,
	}

	const readConnections = createReadConnections({
		createTransport: transport,
		idleMs: READ_CONNECTION_IDLE_MS,
		hardAgeMs: READ_CONNECTION_HARD_AGE_MS,
		channelLimit: READ_CONNECTION_CHANNEL_LIMIT,
		now: () => Date.now(),
	})

	const deps: InstanceControllerDeps = {
		instances,
		schedules,
		commands,
		hosts: { findById: async () => hostRow },
		sshKeys: {
			findById: async () => ({
				id: "key-sandbox",
				organizationId: ORGANIZATION,
				name: "sandbox",
				publicKey: "ssh-ed25519 AAAA",
				privateKeyEncrypted: sealed.ciphertext,
				privateKeyKeyId: sealed.keyId,
				createdAt: new Date(),
			}),
		},
		secrets,
		createTransport: transport,
		readConnections,
		now: () => Date.now(),
		withTransaction: async (fn) =>
			await fn({
				instances,
				schedules,
				commands,
				hosts: { findById: async () => hostRow, lockHost: async () => undefined },
				audit: {
					record: async (_scope, entry) => ({
						id: randomUUID(),
						organizationId: ORGANIZATION,
						createdAt: new Date(),
						...entry,
					}),
				},
			}),
	}

	return { controller: createInstanceController(deps), rows, readConnections }
}
