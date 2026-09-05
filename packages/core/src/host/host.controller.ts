import {
	type CheckHostInput,
	type CreateHostInput,
	can,
	type HostCheckReport,
	type Role,
} from "@open-mcc/contracts"
import { algorithmFromKey } from "@open-mcc/contracts/boundary/ssh"
import type { Db, HostRow } from "@open-mcc/db"
import { type HostTransport, verifyHostKey } from "@open-mcc/transport"
import { type AuditRepository, createAuditRepository } from "../audit/audit.repository"
import type { SecretStore } from "../crypto/sealed-box"
import { redactError } from "../security/redact"
import type { SshKeyRepository } from "../ssh-key/ssh-key.repository"
import { checkHostOverTransport, unreachableReport } from "./check"
import {
	createHostRepository,
	type HostKeyTrustUpdate,
	type HostRepository,
	isProvisioningClaimStale,
} from "./host.repository"
import { profileFrom } from "./profile"
import { type ProvisionResult, provisionHost } from "./provision"
import { type TeardownReport, tearDownHost } from "./teardown"

export type ActorContext = {
	organizationId: string
	memberId: string
	actorLabel: string
	role: Role
}

export type HostTransactionRepos = {
	hosts: HostRepository
	audit: Pick<AuditRepository, "record">
}

export type RetrustHostKeyInput = {
	hostKeyFingerprint: string
	hostKeyAlgorithm: string
}

export type WithTransaction = <T>(fn: (repos: HostTransactionRepos) => Promise<T>) => Promise<T>

export const createHostControllerTransaction = (db: Db): WithTransaction => {
	const withTransaction: WithTransaction = (fn) =>
		db
			.transaction()
			.execute((tx) => fn({ hosts: createHostRepository(tx), audit: createAuditRepository(tx) }))
	return withTransaction
}

export type HostControllerDeps = {
	hosts: HostRepository
	sshKeys: Pick<SshKeyRepository, "findById">
	secrets: SecretStore
	probeHostKey: (hostname: string, port: number, timeoutMs: number) => Promise<Buffer>
	createTransport: () => HostTransport
	instanceIdsOnHost: (scope: { organizationId: string }, hostId: string) => Promise<string[]>
	withTransaction: WithTransaction
}

const PROBE_TIMEOUT_MS = 10_000
export const CONNECT_TIMEOUT_MS = 10_000

export class ForbiddenError extends Error {}
export class HostUnreachableError extends Error {}
export class HostProvisioningFailedError extends Error {}
export class FingerprintMismatchError extends Error {}
export class HostNotFoundError extends Error {}
export class SshKeyNotFoundError extends Error {}
export class HostMisconfiguredError extends Error {}
export class HostConcurrentlyModifiedError extends Error {}
export class HostProvisioningInProgressError extends Error {}

export const createHostController = (deps: HostControllerDeps) => {
	const cleanHost = async (host: HostRow): Promise<TeardownReport | undefined> => {
		if (!host.sshKeyId || !host.hostKeyFingerprint || !host.instancesRoot || !host.unitDir) {
			return undefined
		}
		const key = await deps.sshKeys.findById({ organizationId: host.organizationId }, host.sshKeyId)
		if (!key) return undefined

		const profile = profileFrom(host.mode, host.instancesRoot, host.unitDir)
		const instanceIds = await deps.instanceIdsOnHost(
			{ organizationId: host.organizationId },
			host.id,
		)
		let transport: HostTransport | undefined
		try {
			transport = deps.createTransport()
			await transport.connect({
				hostname: host.hostname,
				port: host.port,
				username: host.username,
				privateKey: deps.secrets.open(key.privateKeyEncrypted, key.privateKeyKeyId),
				expectedFingerprint: host.hostKeyFingerprint,
				timeoutMs: CONNECT_TIMEOUT_MS,
			})
			return await tearDownHost(transport, profile, instanceIds)
		} catch (error) {
			console.error(
				`host.delete: could not clean host ${host.id}`,
				redactError(error instanceof Error ? error : String(error)),
			)
			return undefined
		} finally {
			await transport?.close().catch(() => undefined)
		}
	}

	return {
		checkHost: async (ctx: ActorContext, input: CheckHostInput): Promise<HostCheckReport> => {
			if (!can(ctx.role, "host.enroll")) throw new ForbiddenError("Forbidden: host.enroll")
			const scope = { organizationId: ctx.organizationId }

			const key = await deps.sshKeys.findById(scope, input.sshKeyId)
			if (!key) throw new SshKeyNotFoundError(`SSH key not found: ${input.sshKeyId}`)

			const transport = deps.createTransport()
			try {
				await transport.connect({
					hostname: input.hostname,
					port: input.port,
					username: input.username,
					privateKey: deps.secrets.open(key.privateKeyEncrypted, key.privateKeyKeyId),
					expectedFingerprint: input.expectedFingerprint,
					timeoutMs: CONNECT_TIMEOUT_MS,
				})
			} catch (error) {
				await transport.close().catch(() => undefined)
				return unreachableReport(
					error instanceof Error ? error.message : `Could not reach ${input.hostname}`,
				)
			}

			try {
				return await checkHostOverTransport(transport, input.mode)
			} finally {
				await transport.close().catch(() => undefined)
			}
		},

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
					mode: input.mode,
					sshKeyId: input.sshKeyId,
					hostKeyAlgorithm: algorithm,
					hostKeyFingerprint: verification.fingerprint,
					hostKeyTrustedBy: ctx.memberId,
					hostKeyTrustedByLabel: ctx.actorLabel,
					hostKeyTrustedAt: new Date(),
					status: "pending",
				})

				await repos.audit.record(scope, {
					actorId: ctx.memberId,
					actorLabel: ctx.actorLabel,
					action: "host.enroll",
					subjectType: "host",
					subjectId: created.id,
					detail: {
						hostname: input.hostname,
						fingerprint: verification.fingerprint,
						mode: input.mode,
					},
				})

				return created
			})
		},

		provision: async (ctx: ActorContext, hostId: string) => {
			if (!can(ctx.role, "host.enroll")) throw new ForbiddenError("Forbidden: host.enroll")

			const scope = { organizationId: ctx.organizationId }
			const found = await deps.hosts.findById(scope, hostId)
			if (!found) throw new HostNotFoundError(`Host not found: ${hostId}`)
			const wasAbandonedProvisioning = found.status === "provisioning"
			if (wasAbandonedProvisioning && !isProvisioningClaimStale(found.provisioningClaimedAt)) {
				throw new HostProvisioningInProgressError(`Host ${hostId} is already provisioning`)
			}
			if (!found.sshKeyId) {
				throw new HostMisconfiguredError(`Host ${hostId} has no ssh key configured`)
			}
			if (!found.hostKeyFingerprint) {
				throw new HostMisconfiguredError(`Host ${hostId} has no trusted host key fingerprint`)
			}
			const expectedStatus = found.status

			const sshKeyRow = await deps.sshKeys.findById(scope, found.sshKeyId)
			if (!sshKeyRow) throw new SshKeyNotFoundError(`SSH key not found: ${found.sshKeyId}`)

			const claim = await deps.withTransaction(async (repos) => {
				await repos.hosts.lockHost(scope, hostId)

				const locked = await repos.hosts.findById(scope, hostId)
				if (!locked) throw new HostNotFoundError(`Host not found: ${hostId}`)
				if (!locked.hostKeyFingerprint) {
					throw new HostMisconfiguredError(`Host ${hostId} has no trusted host key fingerprint`)
				}
				if (locked.sshKeyId !== found.sshKeyId) {
					throw new HostConcurrentlyModifiedError(
						`Host ${hostId} changed its ssh key before provisioning could start`,
					)
				}
				const expectedFingerprint = locked.hostKeyFingerprint

				const reclaimed = locked.status === "provisioning"
				const previousAttemptId = locked.provisioningAttemptId ?? ""

				const row = await repos.hosts.claimForProvisioning(scope, hostId, expectedStatus)
				if (!row) return undefined
				if (reclaimed) {
					await repos.audit.record(scope, {
						actorId: ctx.memberId,
						actorLabel: ctx.actorLabel,
						action: "host.provision.reclaim",
						subjectType: "host",
						subjectId: hostId,
						detail: { previousAttemptId },
					})
				}
				return { row, expectedFingerprint }
			})
			if (!claim) {
				throw new HostConcurrentlyModifiedError(
					`Host ${hostId} changed before provisioning could start`,
				)
			}
			const claimed = claim.row
			const attemptId = claimed.provisioningAttemptId
			if (attemptId === null) {
				throw new Error(`Host ${hostId} was claimed for provisioning without an attempt id`)
			}
			const expectedFingerprint = claim.expectedFingerprint

			const closeQuietly = async (transport: HostTransport): Promise<void> => {
				try {
					await transport.close()
				} catch (error) {
					console.error(
						"provision: failed to close transport",
						redactError(error instanceof Error ? error : String(error)),
					)
				}
			}

			const runProvision = async (): Promise<ProvisionResult> => {
				const transport = deps.createTransport()
				try {
					const privateKey = deps.secrets.open(
						sshKeyRow.privateKeyEncrypted,
						sshKeyRow.privateKeyKeyId,
					)
					try {
						await transport.connect({
							hostname: claimed.hostname,
							port: claimed.port,
							username: claimed.username,
							privateKey,
							expectedFingerprint,
							timeoutMs: CONNECT_TIMEOUT_MS,
						})
					} catch (error) {
						throw new HostUnreachableError(
							error instanceof Error ? error.message : `Could not reach ${claimed.hostname}`,
						)
					}
					return await provisionHost(transport, {
						mode: claimed.mode,
						onProgress: (progress) => {
							void deps.hosts
								.recordProvisioningProgress(scope, hostId, attemptId, progress)
								.catch(() => undefined)
						},
					})
				} finally {
					await closeQuietly(transport)
				}
			}

			const runProvisionTracked = async (): Promise<ProvisionResult> => {
				try {
					return await runProvision()
				} catch (error) {
					try {
						await deps.hosts.recordProvisioningFailure(
							scope,
							hostId,
							attemptId,
							error instanceof Error ? error.message : "Provisioning failed",
						)
						await deps.withTransaction(async (repos) => {
							await repos.hosts.lockHost(scope, hostId)
							await repos.hosts.finalizeProvisioning(scope, hostId, attemptId, { status: "error" })
						})
					} catch (updateError) {
						console.error(
							"provision: failed to record error status",
							redactError(updateError instanceof Error ? updateError : String(updateError)),
						)
					}
					if (error instanceof HostUnreachableError) throw error
					throw new HostProvisioningFailedError(
						error instanceof Error ? error.message : "Provisioning failed",
					)
				}
			}

			const result = await runProvisionTracked()

			return deps.withTransaction(async (repos) => {
				await repos.hosts.lockHost(scope, hostId)

				const updated = await repos.hosts.finalizeProvisioning(scope, hostId, attemptId, {
					status: "ready",
					osRelease: result.osRelease,
					instancesRoot: result.profile.instancesRoot,
					unitDir: result.profile.unitDir,
					sandboxed: result.sandboxed,
					osId: result.osId,
					osName: result.osName,
				})
				if (!updated) {
					throw new HostConcurrentlyModifiedError(
						`Host ${hostId} changed before provisioning could complete`,
					)
				}

				await repos.audit.record(scope, {
					actorId: ctx.memberId,
					actorLabel: ctx.actorLabel,
					action: "host.provision",
					subjectType: "host",
					subjectId: hostId,
					detail: { osRelease: result.osRelease, mode: result.profile.mode },
				})

				return updated
			})
		},

		retrustHostKey: async (ctx: ActorContext, hostId: string, trust: RetrustHostKeyInput) => {
			if (!can(ctx.role, "host.enroll")) throw new ForbiddenError("Forbidden: host.enroll")
			const scope = { organizationId: ctx.organizationId }

			return deps.withTransaction(async (repos) => {
				await repos.hosts.lockHost(scope, hostId)

				const found = await repos.hosts.findById(scope, hostId)
				if (
					found?.status === "provisioning" &&
					!isProvisioningClaimStale(found.provisioningClaimedAt)
				) {
					throw new HostProvisioningInProgressError(
						`Host ${hostId} cannot be re-trusted while a provisioning attempt is in progress`,
					)
				}

				const trustUpdate: HostKeyTrustUpdate = {
					hostKeyTrustedBy: ctx.memberId,
					hostKeyTrustedByLabel: ctx.actorLabel,
					hostKeyFingerprint: trust.hostKeyFingerprint,
					hostKeyAlgorithm: trust.hostKeyAlgorithm,
					hostKeyTrustedAt: new Date(),
				}
				const updated = await repos.hosts.updateHostKeyTrust(scope, hostId, trustUpdate)
				if (!updated) throw new HostNotFoundError(`Host not found: ${hostId}`)

				await repos.audit.record(scope, {
					actorId: ctx.memberId,
					actorLabel: ctx.actorLabel,
					action: "host.retrust",
					subjectType: "host",
					subjectId: hostId,
					detail: { fingerprint: trust.hostKeyFingerprint },
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

			const target = await deps.hosts.findById(scope, hostId)

			const removedHost = await deps.withTransaction(async (repos) => {
				await repos.hosts.lockHost(scope, hostId)
				const found = await repos.hosts.findById(scope, hostId)
				if (
					found?.status === "provisioning" &&
					!isProvisioningClaimStale(found.provisioningClaimedAt)
				) {
					throw new HostProvisioningInProgressError(
						`Host ${hostId} cannot be deleted while its status is 'provisioning'`,
					)
				}
				const removed = await repos.hosts.delete(scope, hostId)
				if (removed) {
					await repos.audit.record(scope, {
						actorId: ctx.memberId,
						actorLabel: ctx.actorLabel,
						action: "host.delete",
						subjectType: "host",
						subjectId: hostId,
						detail: {},
					})
				}
				return removed
			})

			if (!removedHost || !target) return removedHost

			const cleaned = await cleanHost(target)
			await deps
				.withTransaction(async (repos) => {
					await repos.audit.record(scope, {
						actorId: ctx.memberId,
						actorLabel: ctx.actorLabel,
						action: "host.teardown",
						subjectType: "host",
						subjectId: hostId,
						detail: cleaned
							? {
									unitsRemoved: String(cleaned.unitsRemoved.length),
									accountsRemoved: String(cleaned.accountsRemoved.length),
									directoryRemoved: String(cleaned.directoryRemoved),
									lingeringLeft: String(cleaned.lingeringLeft),
									remaining: cleaned.remaining.join("; "),
								}
							: { reached: "false" },
					})
				})
				.catch(() => undefined)

			return removedHost
		},
	}
}

export type HostController = ReturnType<typeof createHostController>
