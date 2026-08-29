import { type CreateHostInput, can, type Role } from "@open-mcc/contracts"
import { algorithmFromKey } from "@open-mcc/contracts/boundary/ssh"
import type { Db } from "@open-mcc/db"
import { type HostTransport, verifyHostKey } from "@open-mcc/transport"
import { type AuditRepository, createAuditRepository } from "../audit/audit.repository"
import type { SecretStore } from "../crypto/sealed-box"
import type { SshKeyRepository } from "../ssh-key/ssh-key.repository"
import { createHostRepository, type HostRepository } from "./host.repository"
import { type ProvisionResult, provisionHost } from "./provision"

export type ActorContext = {
	organizationId: string
	memberId: string
	role: Role
}

export type HostTransactionRepos = {
	hosts: HostRepository
	audit: Pick<AuditRepository, "record">
}

export type WithTransaction = <T>(fn: (repos: HostTransactionRepos) => Promise<T>) => Promise<T>

export const createHostControllerTransaction = (db: Db): WithTransaction => {
	const withTransaction: WithTransaction = (fn) =>
		db.transaction((tx) =>
			fn({ hosts: createHostRepository(tx), audit: createAuditRepository(tx) }),
		)
	return withTransaction
}

export type HostControllerDeps = {
	hosts: HostRepository
	sshKeys: Pick<SshKeyRepository, "findById">
	secrets: SecretStore
	probeHostKey: (hostname: string, port: number, timeoutMs: number) => Promise<Buffer>
	createTransport: () => HostTransport
	instancesRoot: string
	withTransaction: WithTransaction
}

const PROBE_TIMEOUT_MS = 10_000
const CONNECT_TIMEOUT_MS = 10_000

export class ForbiddenError extends Error {}
export class FingerprintMismatchError extends Error {}
export class HostNotFoundError extends Error {}
export class SshKeyNotFoundError extends Error {}
export class HostMisconfiguredError extends Error {}

export const createHostController = (deps: HostControllerDeps) => ({
	enroll: async (ctx: ActorContext, input: CreateHostInput) => {
		if (!can(ctx.role, "host.enroll")) throw new ForbiddenError("Forbidden: host.enroll")

		const presented = await deps.probeHostKey(input.hostname, input.port, PROBE_TIMEOUT_MS)
		const verification = verifyHostKey(presented, input.expectedFingerprint)
		if (!verification.ok) {
			throw new FingerprintMismatchError(`Host key fingerprint mismatch for ${input.hostname}`)
		}
		const algorithm = algorithmFromKey(presented)

		const scope = { organizationId: ctx.organizationId }
		return deps.withTransaction(async (repos) => {
			const created = await repos.hosts.insert(scope, {
				name: input.name,
				hostname: input.hostname,
				port: input.port,
				username: input.username,
				sshKeyId: input.sshKeyId,
				hostKeyAlgorithm: algorithm,
				hostKeyFingerprint: verification.fingerprint,
				hostKeyTrustedBy: ctx.memberId,
				hostKeyTrustedAt: new Date(),
				status: "pending",
			})

			await repos.audit.record(scope, {
				actorId: ctx.memberId,
				action: "host.enroll",
				subjectType: "host",
				subjectId: created.id,
				detail: { hostname: input.hostname, fingerprint: verification.fingerprint },
			})

			return created
		})
	},

	provision: async (ctx: ActorContext, hostId: string) => {
		if (!can(ctx.role, "host.enroll")) throw new ForbiddenError("Forbidden: host.enroll")

		const scope = { organizationId: ctx.organizationId }
		const found = await deps.hosts.findById(scope, hostId)
		if (!found) throw new HostNotFoundError(`Host not found: ${hostId}`)
		if (!found.sshKeyId) {
			throw new HostMisconfiguredError(`Host ${hostId} has no ssh key configured`)
		}
		if (!found.hostKeyFingerprint) {
			throw new HostMisconfiguredError(`Host ${hostId} has no trusted host key fingerprint`)
		}
		const expectedFingerprint = found.hostKeyFingerprint

		const sshKeyRow = await deps.sshKeys.findById(scope, found.sshKeyId)
		if (!sshKeyRow) throw new SshKeyNotFoundError(`SSH key not found: ${found.sshKeyId}`)

		await deps.hosts.update(scope, hostId, { status: "provisioning" })

		const closeQuietly = async (transport: HostTransport): Promise<void> => {
			try {
				await transport.close()
			} catch (error) {
				console.error("provision: failed to close transport", error)
			}
		}

		const runProvision = async (): Promise<ProvisionResult> => {
			const transport = deps.createTransport()
			try {
				const privateKey = deps.secrets.open(
					sshKeyRow.privateKeyEncrypted,
					sshKeyRow.privateKeyKeyId,
				)
				await transport.connect({
					hostname: found.hostname,
					port: found.port,
					username: found.username,
					privateKey,
					expectedFingerprint,
					timeoutMs: CONNECT_TIMEOUT_MS,
				})
				return await provisionHost(transport, { instancesRoot: deps.instancesRoot })
			} finally {
				await closeQuietly(transport)
			}
		}

		const runProvisionTracked = async (): Promise<ProvisionResult> => {
			try {
				return await runProvision()
			} catch (error) {
				try {
					await deps.hosts.update(scope, hostId, { status: "error" })
				} catch (updateError) {
					console.error("provision: failed to record error status", updateError)
				}
				throw error
			}
		}

		const result = await runProvisionTracked()

		return deps.withTransaction(async (repos) => {
			const updated = await repos.hosts.update(scope, hostId, {
				status: "ready",
				dockerVersion: result.dockerVersion,
			})

			await repos.audit.record(scope, {
				actorId: ctx.memberId,
				action: "host.provision",
				subjectType: "host",
				subjectId: hostId,
				detail: { dockerVersion: result.dockerVersion },
			})

			return updated
		})
	},

	list: async (ctx: ActorContext) => {
		if (!can(ctx.role, "instance.read")) throw new ForbiddenError("Forbidden: read")
		return deps.hosts.list({ organizationId: ctx.organizationId })
	},

	remove: async (ctx: ActorContext, hostId: string) => {
		if (!can(ctx.role, "host.enroll")) throw new ForbiddenError("Forbidden: host.delete")
		const scope = { organizationId: ctx.organizationId }
		return deps.withTransaction(async (repos) => {
			const removed = await repos.hosts.delete(scope, hostId)
			if (removed) {
				await repos.audit.record(scope, {
					actorId: ctx.memberId,
					action: "host.delete",
					subjectType: "host",
					subjectId: hostId,
					detail: {},
				})
			}
			return removed
		})
	},
})

export type HostController = ReturnType<typeof createHostController>
