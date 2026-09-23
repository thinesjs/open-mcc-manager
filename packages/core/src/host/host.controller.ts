import {
	type AddressProbeReport,
	type CheckHostInput,
	type CreateHostInput,
	can,
	EXPRESS_ROOT_USERNAME,
	type ExpressInstallInput,
	type ExpressInstallResult,
	type HostCheckReport,
	type HostKeyReport,
	type HostPublic,
	type ProbeAddressInput,
	type ReadHostKeyInput,
	type Role,
} from "@open-mcc/contracts"
import { algorithmFromKey, fingerprintFromKey } from "@open-mcc/contracts/boundary/ssh"
import type { Db, HostRow } from "@open-mcc/db"
import {
	type HostTransport,
	type RootSession,
	type SshHandshake,
	verifyHostKey,
} from "@open-mcc/transport"
import { type AuditRepository, createAuditRepository } from "../audit/audit.repository"
import type { SecretStore } from "../crypto/sealed-box"
import { createJobQueue, JobNotQueuedError, type JobQueue, type SendJob } from "../job/job.queue"
import { HOST_TEARDOWN_QUEUE } from "../job/queue-setup"
import { InternalError } from "../lib/errors"
import type { RuntimeErrorReporter } from "../log/reporters"
import { redactError } from "../security/redact"
import type { SshKeyRepository } from "../ssh-key/ssh-key.repository"
import { ADDRESS_PROBE_TIMEOUT_MS, addressProbeOutcomeFor } from "./address-probe"
import { checkAuditDetail, checkHostOverTransport, unreachableReport } from "./check"
import {
	connectFailureOutcome,
	EXPRESS_CONNECT_TIMEOUT_MS,
	EXPRESS_SETUP_TIMEOUT_MS,
	expressAuditDetail,
	expressSetupCommand,
	rootCredentialFor,
	runFailureOutcome,
	scriptOutcome,
	secretOf,
} from "./express-install"
import {
	createHostRepository,
	type HostKeyTrustUpdate,
	type HostRepository,
	isProvisioningClaimStale,
} from "./host.repository"
import {
	HostProvisioningFailedError,
	type ProvisionProgress,
	type ProvisionResult,
	provisionHost,
} from "./provision"
import { provisioningFailureFor } from "./provision-failure"
import { COULD_NOT_CONNECT, connectFailureReason } from "./unreachable"

export type ActorContext = {
	organizationId: string
	memberId: string
	actorLabel: string
	role: Role
}

export type HostTransactionRepos = {
	hosts: HostRepository
	audit: Pick<AuditRepository, "record">
	jobs: JobQueue
}

export type RetrustHostKeyInput = {
	hostKeyFingerprint: string
}

export type WithTransaction = <T>(fn: (repos: HostTransactionRepos) => Promise<T>) => Promise<T>

export const createHostControllerTransaction = (db: Db, sendJob: SendJob): WithTransaction => {
	const withTransaction: WithTransaction = (fn) =>
		db.transaction().execute((tx) =>
			fn({
				hosts: createHostRepository(tx),
				audit: createAuditRepository(tx),
				jobs: createJobQueue(sendJob, tx),
			}),
		)
	return withTransaction
}

export type HostControllerDeps = {
	hosts: HostRepository
	sshKeys: Pick<SshKeyRepository, "findById">
	secrets: SecretStore
	probeHostKey: (hostname: string, port: number, timeoutMs: number) => Promise<Buffer>
	probeSshHandshake: (hostname: string, port: number, timeoutMs: number) => Promise<SshHandshake>
	createTransport: () => HostTransport
	createRootSession: () => RootSession
	evictHost: (organizationId: string, hostId: string) => void
	now: () => Date
	withTransaction: WithTransaction
	onError?: RuntimeErrorReporter
}

const PROBE_TIMEOUT_MS = 10_000
export const CONNECT_TIMEOUT_MS = 10_000

export class ForbiddenError extends Error {}
export class HostUnreachableError extends Error {}
export class FingerprintMismatchError extends Error {}
export class HostNotFoundError extends Error {}
export class HostHasInstancesError extends Error {}
export class SshKeyNotFoundError extends Error {}
export class HostMisconfiguredError extends Error {}
export class HostConcurrentlyModifiedError extends Error {}
export class HostRemovalNotStartedError extends Error {}
export class HostProvisioningInProgressError extends Error {}
export class HostKeyUnreadableError extends Error {}

const toHostPublic = (row: HostRow): HostPublic => ({
	id: row.id,
	name: row.name,
	hostname: row.hostname,
	port: row.port,
	username: row.username,
	status: row.status,
	hostKeyFingerprint: row.hostKeyFingerprint,
	hostKeyAlgorithm: row.hostKeyAlgorithm,
	hostKeyTrustedAt: row.hostKeyTrustedAt?.toISOString() ?? null,
	hostKeyTrustedByLabel: row.hostKeyTrustedByLabel,
	osId: row.osId,
	osName: row.osName,
	osRelease: row.osRelease,
	lastSeenAt: row.lastSeenAt?.toISOString() ?? null,
	failedUnits: row.failedUnits,
	provisioningStep: row.provisioningStep,
	provisioningStepIndex: row.provisioningStepIndex,
	provisioningStepTotal: row.provisioningStepTotal,
	provisioningError: row.provisioningError,
	teardownError: row.teardownError,
	teardownRequestedAt: row.teardownRequestedAt?.toISOString() ?? null,
})

const finishedProvisioning = (host: HostRow): boolean => host.osRelease !== null

type HostCheckAttempt =
	| { kind: "reported"; report: HostCheckReport }
	| { kind: "interrupted"; error: Error }

export const createHostController = (deps: HostControllerDeps) => {
	const teardownPayloadFor = (host: HostRow): Record<string, string> | undefined => {
		if (!host.sshKeyId || !host.hostKeyFingerprint || !finishedProvisioning(host)) {
			return undefined
		}
		return {
			hostId: host.id,
			hostname: host.hostname,
			port: String(host.port),
			username: host.username,
			sshKeyId: host.sshKeyId,
			hostKeyFingerprint: host.hostKeyFingerprint,
		}
	}

	return {
		probeAddress: async (
			ctx: ActorContext,
			input: ProbeAddressInput,
		): Promise<AddressProbeReport> => {
			if (!can(ctx.role, "host.enroll")) throw new ForbiddenError("Forbidden: host.enroll")
			const handshake = await deps.probeSshHandshake(
				input.hostname,
				input.port,
				ADDRESS_PROBE_TIMEOUT_MS,
			)
			return { outcome: addressProbeOutcomeFor(handshake) }
		},

		readHostKey: async (ctx: ActorContext, input: ReadHostKeyInput): Promise<HostKeyReport> => {
			if (!can(ctx.role, "host.enroll")) throw new ForbiddenError("Forbidden: host.enroll")
			let presented: Buffer
			try {
				presented = await deps.probeHostKey(input.hostname, input.port, PROBE_TIMEOUT_MS)
			} catch (error) {
				throw new HostKeyUnreadableError(
					error instanceof Error ? connectFailureReason(error) : COULD_NOT_CONNECT,
				)
			}
			return {
				fingerprint: fingerprintFromKey(presented),
				algorithm: algorithmFromKey(presented),
			}
		},

		expressInstall: async (
			ctx: ActorContext,
			input: ExpressInstallInput,
		): Promise<ExpressInstallResult> => {
			if (!can(ctx.role, "host.enroll")) throw new ForbiddenError("Forbidden: host.enroll")
			const scope = { organizationId: ctx.organizationId }

			const key = await deps.sshKeys.findById(scope, input.sshKeyId)
			if (!key) throw new SshKeyNotFoundError(`SSH key not found: ${input.sshKeyId}`)

			const secret = secretOf(input)
			const session = deps.createRootSession()
			const outcome = await (async (): Promise<ExpressInstallResult> => {
				try {
					await session.connect({
						hostname: input.hostname,
						port: input.port,
						username: EXPRESS_ROOT_USERNAME,
						credential: rootCredentialFor(input),
						expectedFingerprint: input.expectedFingerprint,
						timeoutMs: EXPRESS_CONNECT_TIMEOUT_MS,
					})
				} catch (error) {
					return connectFailureOutcome(
						error instanceof Error ? error : new InternalError(COULD_NOT_CONNECT),
					)
				}
				try {
					const result = await session.run(
						expressSetupCommand(input, key.publicKey),
						EXPRESS_SETUP_TIMEOUT_MS,
					)
					return scriptOutcome(result, input, secret)
				} catch (error) {
					return runFailureOutcome(
						error instanceof Error ? error : new InternalError(COULD_NOT_CONNECT),
						secret,
					)
				} finally {
					session.close()
				}
			})()

			await deps.withTransaction(async (repos) => {
				await repos.audit.record(scope, {
					actorId: ctx.memberId,
					actorLabel: ctx.actorLabel,
					action: "host.express",
					subjectType: "host",
					subjectId: input.hostname,
					detail: expressAuditDetail(input, outcome),
				})
			})

			return outcome
		},

		checkHost: async (ctx: ActorContext, input: CheckHostInput): Promise<HostCheckReport> => {
			if (!can(ctx.role, "host.enroll")) throw new ForbiddenError("Forbidden: host.enroll")
			const scope = { organizationId: ctx.organizationId }

			const key = await deps.sshKeys.findById(scope, input.sshKeyId)
			if (!key) throw new SshKeyNotFoundError(`SSH key not found: ${input.sshKeyId}`)

			const privateKey = deps.secrets.open(key.privateKeyEncrypted, key.privateKeyKeyId)

			const attempt = await (async (): Promise<HostCheckAttempt> => {
				const transport = deps.createTransport()
				try {
					await transport.connect({
						hostname: input.hostname,
						port: input.port,
						username: input.username,
						privateKey,
						expectedFingerprint: input.expectedFingerprint,
						timeoutMs: CONNECT_TIMEOUT_MS,
					})
				} catch (error) {
					await transport.close().catch(() => undefined)
					return {
						kind: "reported",
						report: unreachableReport(
							error instanceof Error ? connectFailureReason(error) : COULD_NOT_CONNECT,
						),
					}
				}

				try {
					return {
						kind: "reported",
						report: await checkHostOverTransport(transport, input.username),
					}
				} catch (error) {
					return {
						kind: "interrupted",
						error: error instanceof Error ? error : new InternalError(COULD_NOT_CONNECT),
					}
				} finally {
					await transport.close().catch(() => undefined)
				}
			})()

			await deps.withTransaction(async (repos) => {
				await repos.audit.record(scope, {
					actorId: ctx.memberId,
					actorLabel: ctx.actorLabel,
					action: "host.check",
					subjectType: "host",
					subjectId: input.hostname,
					detail: checkAuditDetail(input, attempt.kind === "reported" ? attempt.report : null),
				})
			})

			if (attempt.kind === "interrupted") throw attempt.error
			return attempt.report
		},

		enroll: async (ctx: ActorContext, input: CreateHostInput) => {
			if (!can(ctx.role, "host.enroll")) throw new ForbiddenError("Forbidden: host.enroll")

			let presented: Buffer
			try {
				presented = await deps.probeHostKey(input.hostname, input.port, PROBE_TIMEOUT_MS)
			} catch (error) {
				throw new HostUnreachableError(
					error instanceof Error ? connectFailureReason(error) : COULD_NOT_CONNECT,
				)
			}
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
					},
				})

				return toHostPublic(created)
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
				throw new InternalError(`Host ${hostId} was claimed for provisioning without an attempt id`)
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

			let reached: ProvisionProgress | undefined

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
							error instanceof Error ? connectFailureReason(error) : COULD_NOT_CONNECT,
						)
					}
					return await provisionHost(transport, {
						onProgress: (progress) => {
							reached = progress
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
					const failure =
						error instanceof HostUnreachableError
							? error.message
							: provisioningFailureFor(
									reached?.step,
									error instanceof HostProvisioningFailedError ? error.storage : null,
									error instanceof HostProvisioningFailedError && error.downloadRanOutOfTime,
								)
					deps.onError?.(
						`Provisioning host ${hostId} did not finish`,
						error instanceof Error ? error : String(error),
					)
					try {
						await deps.hosts.recordProvisioningFailure(scope, hostId, attemptId, failure, reached)
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
					throw new HostProvisioningFailedError(failure)
				}
			}

			const result = await runProvisionTracked()

			return deps.withTransaction(async (repos) => {
				await repos.hosts.lockHost(scope, hostId)

				const updated = await repos.hosts.finalizeProvisioning(scope, hostId, attemptId, {
					status: "ready",
					osRelease: result.osRelease,
					osId: result.osId,
					osName: result.osName,
					networkStack: result.networkStack,
					architecture: result.architecture,
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
					detail: { osRelease: result.osRelease },
				})

				return toHostPublic(updated)
			})
		},

		retrustHostKey: async (ctx: ActorContext, hostId: string, trust: RetrustHostKeyInput) => {
			if (!can(ctx.role, "host.enroll")) throw new ForbiddenError("Forbidden: host.enroll")
			const scope = { organizationId: ctx.organizationId }

			const target = await deps.hosts.findById(scope, hostId)
			if (!target) throw new HostNotFoundError(`Host not found: ${hostId}`)
			let presented: Buffer
			try {
				presented = await deps.probeHostKey(target.hostname, target.port, PROBE_TIMEOUT_MS)
			} catch (error) {
				throw new HostUnreachableError(
					error instanceof Error ? connectFailureReason(error) : COULD_NOT_CONNECT,
				)
			}
			const verification = verifyHostKey(presented, trust.hostKeyFingerprint)
			if (!verification.ok) {
				throw new FingerprintMismatchError(`Host key fingerprint mismatch for host ${hostId}`)
			}
			const algorithm = algorithmFromKey(presented)

			const retrusted = await deps.withTransaction(async (repos) => {
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
					hostKeyFingerprint: verification.fingerprint,
					hostKeyAlgorithm: algorithm,
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
					detail: { fingerprint: verification.fingerprint },
				})

				return toHostPublic(updated)
			})
			deps.evictHost(ctx.organizationId, hostId)
			return retrusted
		},

		list: async (ctx: ActorContext) => {
			if (!can(ctx.role, "instance.read")) throw new ForbiddenError("Forbidden: read")
			return (await deps.hosts.list({ organizationId: ctx.organizationId })).map(toHostPublic)
		},

		remove: async (ctx: ActorContext, hostId: string) => {
			if (!can(ctx.role, "host.enroll")) throw new ForbiddenError("Forbidden: host.delete")
			const scope = { organizationId: ctx.organizationId }

			const target = await deps.hosts.findById(scope, hostId)
			if (!target) return false

			const removed = await deps.withTransaction(async (repos) => {
				await repos.hosts.lockHost(scope, hostId)
				const found = await repos.hosts.findById(scope, hostId)
				if (!found) return false
				const instances = await repos.hosts.instanceCount(scope, hostId)
				if (instances > 0) {
					throw new HostHasInstancesError(
						`Host ${hostId} still has ${instances} instance(s); remove them first`,
					)
				}
				if (
					found.status === "provisioning" &&
					!isProvisioningClaimStale(found.provisioningClaimedAt)
				) {
					throw new HostProvisioningInProgressError(
						`Host ${hostId} cannot be deleted while its status is 'provisioning'`,
					)
				}

				const teardownPayload = teardownPayloadFor(found)
				if (!teardownPayload) {
					const removed = await repos.hosts.delete(scope, hostId)
					if (removed) {
						await repos.audit.record(scope, {
							actorId: ctx.memberId,
							actorLabel: ctx.actorLabel,
							action: "host.delete",
							subjectType: "host",
							subjectId: hostId,
							detail: { cleaned: "nothing was installed" },
						})
					}
					return removed
				}

				await repos.hosts.beginTeardown(scope, hostId, deps.now())
				try {
					await repos.jobs.enqueue(HOST_TEARDOWN_QUEUE, {
						...teardownPayload,
						organizationId: ctx.organizationId,
					})
				} catch (error) {
					if (!(error instanceof JobNotQueuedError)) throw error
					throw new HostRemovalNotStartedError(`Host ${hostId} was not removed: ${error.message}`)
				}
				await repos.audit.record(scope, {
					actorId: ctx.memberId,
					actorLabel: ctx.actorLabel,
					action: "host.teardown.requested",
					subjectType: "host",
					subjectId: hostId,
					detail: {},
				})
				return true
			})
			deps.evictHost(ctx.organizationId, hostId)
			return removed
		},
	}
}

export type HostController = ReturnType<typeof createHostController>
