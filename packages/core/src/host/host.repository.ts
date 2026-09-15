import { randomUUID } from "node:crypto"
import type { Executor, HostInsert, HostRow } from "@open-mcc/db"
import { sql } from "kysely"
import { nanoid } from "nanoid"

export type OrgScope = { organizationId: string }

export type HostCreateValues = Omit<HostInsert, "id" | "organizationId" | "createdAt">

const MUTABLE_HOST_COLUMNS = [
	"name",
	"hostname",
	"port",
	"username",
	"sshKeyId",
	"status",
	"osRelease",
	"cpuCount",
	"memoryMb",
	"lastSeenAt",
	"osId",
	"osName",
	"failedUnits",
] as const

export type HostUpdateValues = Partial<Pick<HostRow, (typeof MUTABLE_HOST_COLUMNS)[number]>>

export type HostKeyTrustUpdate = {
	hostKeyTrustedBy: string
	hostKeyTrustedByLabel: string
	hostKeyFingerprint: string
	hostKeyAlgorithm: string
	hostKeyTrustedAt: Date
}

const UNKNOWN_TRUSTED_BY_LABEL = "unknown"

const requireNonBlankLabel = (label: string): string => {
	if (label.trim().length === 0) {
		throw new Error("hostKeyTrustedByLabel is required when hostKeyTrustedBy is set")
	}
	return label
}

const resolveHostKeyTrustedByLabel = (values: HostCreateValues): string => {
	const label = values.hostKeyTrustedByLabel ?? ""
	if (values.hostKeyTrustedBy === null || values.hostKeyTrustedBy === undefined) {
		return label.trim().length > 0 ? label : UNKNOWN_TRUSTED_BY_LABEL
	}
	return requireNonBlankLabel(label)
}

const TRUST_EVIDENCE_FIELDS = [
	"hostKeyFingerprint",
	"hostKeyAlgorithm",
	"hostKeyTrustedAt",
] as const

const isPresent = (value: string | Date | null | undefined): boolean =>
	value !== null && value !== undefined

const requireConsistentTrustTuple = (values: HostCreateValues): void => {
	const presentEvidenceCount = TRUST_EVIDENCE_FIELDS.filter((field) =>
		isPresent(values[field]),
	).length
	if (presentEvidenceCount !== 0 && presentEvidenceCount !== TRUST_EVIDENCE_FIELDS.length) {
		throw new Error(
			"Host key trust evidence (hostKeyFingerprint, hostKeyAlgorithm, hostKeyTrustedAt) must be set all at once or not at all",
		)
	}
	if (isPresent(values.hostKeyTrustedBy) && presentEvidenceCount === 0) {
		throw new Error(
			"hostKeyTrustedBy cannot be set without hostKeyFingerprint, hostKeyAlgorithm, and hostKeyTrustedAt",
		)
	}
}

export const PROVISIONING_LEASE_MS = 15 * 60 * 1000

export const isProvisioningClaimStale = (claimedAt: Date | null, now: Date = new Date()): boolean =>
	claimedAt === null || now.getTime() - claimedAt.getTime() > PROVISIONING_LEASE_MS

const whitelistHostUpdate = (patch: HostUpdateValues): HostUpdateValues => ({
	...(patch.name !== undefined && { name: patch.name }),
	...(patch.hostname !== undefined && { hostname: patch.hostname }),
	...(patch.port !== undefined && { port: patch.port }),
	...(patch.username !== undefined && { username: patch.username }),
	...(patch.sshKeyId !== undefined && { sshKeyId: patch.sshKeyId }),
	...(patch.status !== undefined && { status: patch.status }),
	...(patch.osRelease !== undefined && { osRelease: patch.osRelease }),
	...(patch.cpuCount !== undefined && { cpuCount: patch.cpuCount }),
	...(patch.memoryMb !== undefined && { memoryMb: patch.memoryMb }),
	...(patch.lastSeenAt !== undefined && { lastSeenAt: patch.lastSeenAt }),
	...(patch.osId !== undefined && { osId: patch.osId }),
	...(patch.osName !== undefined && { osName: patch.osName }),
	...(patch.failedUnits !== undefined && { failedUnits: patch.failedUnits }),
})

export const createHostRepository = (db: Executor) => ({
	beginTeardown: async (scope: OrgScope, id: string, at: Date): Promise<boolean> => {
		const result = await db
			.updateTable("host")
			.set({ status: "removing", teardownRequestedAt: at, teardownError: null })
			.where("id", "=", id)
			.where("organizationId", "=", scope.organizationId)
			.executeTakeFirst()
		return Number(result.numUpdatedRows) > 0
	},

	recordTeardownFailure: async (
		id: string,
		organizationId: string,
		reason: string,
	): Promise<void> => {
		await db
			.updateTable("host")
			.set({ teardownError: reason.slice(0, 2000) })
			.where("id", "=", id)
			.where("organizationId", "=", organizationId)
			.execute()
	},

	deleteAfterTeardown: async (id: string, organizationId: string): Promise<boolean> => {
		const result = await db
			.deleteFrom("host")
			.where("id", "=", id)
			.where("organizationId", "=", organizationId)
			.where("status", "=", "removing")
			.executeTakeFirst()
		return Number(result.numDeletedRows) > 0
	},

	listPollableAcrossOrganizations: async (): Promise<HostRow[]> =>
		db.selectFrom("host").selectAll().where("status", "=", "ready").execute(),

	recordSeen: async (
		id: string,
		organizationId: string,
		seenAt: Date,
		observed: { failedUnits: number; osId: string | null; osName: string | null },
	): Promise<void> => {
		await db
			.updateTable("host")
			.set({
				lastSeenAt: seenAt,
				failedUnits: observed.failedUnits,
				...(observed.osId !== null && { osId: observed.osId }),
				...(observed.osName !== null && { osName: observed.osName }),
			})
			.where("id", "=", id)
			.where("organizationId", "=", organizationId)
			.execute()
	},

	insert: async (scope: OrgScope, values: HostCreateValues): Promise<HostRow> => {
		requireConsistentTrustTuple(values)
		const row = await db
			.insertInto("host")
			.values({
				...values,
				id: nanoid(),
				organizationId: scope.organizationId,
				hostKeyTrustedByLabel: resolveHostKeyTrustedByLabel(values),
			})
			.returningAll()
			.executeTakeFirst()
		if (!row) throw new Error("Host insert returned no row")
		return row
	},

	findById: async (scope: OrgScope, id: string): Promise<HostRow | undefined> =>
		db
			.selectFrom("host")
			.selectAll()
			.where("id", "=", id)
			.where("organizationId", "=", scope.organizationId)
			.limit(1)
			.executeTakeFirst(),

	list: async (scope: OrgScope): Promise<HostRow[]> =>
		db.selectFrom("host").selectAll().where("organizationId", "=", scope.organizationId).execute(),

	update: async (
		scope: OrgScope,
		id: string,
		patch: HostUpdateValues,
	): Promise<HostRow | undefined> =>
		db
			.updateTable("host")
			.set({ ...whitelistHostUpdate(patch), organizationId: scope.organizationId })
			.where("id", "=", id)
			.where("organizationId", "=", scope.organizationId)
			.returningAll()
			.executeTakeFirst(),

	delete: async (scope: OrgScope, id: string): Promise<boolean> => {
		const rows = await db
			.deleteFrom("host")
			.where("id", "=", id)
			.where("organizationId", "=", scope.organizationId)
			.returningAll()
			.execute()
		return rows.length > 0
	},

	recordProvisioningProgress: async (
		scope: OrgScope,
		id: string,
		attemptId: string,
		progress: { step: string; index: number; total: number },
	): Promise<void> => {
		await db
			.updateTable("host")
			.set({
				provisioningStep: progress.step,
				provisioningStepIndex: progress.index,
				provisioningStepTotal: progress.total,
			})
			.where("id", "=", id)
			.where("organizationId", "=", scope.organizationId)
			.where("provisioningAttemptId", "=", attemptId)
			.where("provisioningError", "is", null)
			.execute()
	},

	recordProvisioningFailure: async (
		scope: OrgScope,
		id: string,
		attemptId: string,
		reason: string,
		reached?: { step: string; index: number; total: number },
	): Promise<void> => {
		await db
			.updateTable("host")
			.set({
				provisioningError: reason,
				...(reached !== undefined && {
					provisioningStep: reached.step,
					provisioningStepIndex: reached.index,
					provisioningStepTotal: reached.total,
				}),
			})
			.where("id", "=", id)
			.where("organizationId", "=", scope.organizationId)
			.where("provisioningAttemptId", "=", attemptId)
			.execute()
	},

	lockHost: async (scope: OrgScope, id: string): Promise<void> => {
		const key = `${scope.organizationId}:${id}`
		await sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`.execute(db)
	},

	claimForProvisioning: async (
		scope: OrgScope,
		id: string,
		expectedStatus: HostRow["status"],
	): Promise<HostRow | undefined> => {
		const now = new Date()
		const staleBefore = new Date(now.getTime() - PROVISIONING_LEASE_MS)

		return db
			.updateTable("host")
			.set({
				status: "provisioning",
				provisioningAttemptId: randomUUID(),
				provisioningClaimedAt: now,
				provisioningError: null,
				organizationId: scope.organizationId,
			})
			.where("id", "=", id)
			.where("organizationId", "=", scope.organizationId)
			.where((eb) => {
				const staleClaimCondition = eb.and([
					eb("status", "=", "provisioning"),
					eb.or([
						eb("provisioningClaimedAt", "is", null),
						eb("provisioningClaimedAt", "<", staleBefore),
					]),
				])
				return expectedStatus === "provisioning"
					? staleClaimCondition
					: eb.or([eb("status", "=", expectedStatus), staleClaimCondition])
			})
			.returningAll()
			.executeTakeFirst()
	},

	finalizeProvisioning: async (
		scope: OrgScope,
		id: string,
		attemptId: string,
		patch: Pick<HostUpdateValues, "status" | "osRelease" | "osId" | "osName"> &
			Partial<Pick<HostRow, "networkStack">>,
	): Promise<HostRow | undefined> =>
		db
			.updateTable("host")
			.set({
				...whitelistHostUpdate(patch),
				...(patch.networkStack !== undefined && { networkStack: patch.networkStack }),
				provisioningAttemptId: null,
				provisioningClaimedAt: null,
				organizationId: scope.organizationId,
			})
			.where("id", "=", id)
			.where("organizationId", "=", scope.organizationId)
			.where("status", "=", "provisioning")
			.where("provisioningAttemptId", "=", attemptId)
			.returningAll()
			.executeTakeFirst(),

	updateHostKeyTrust: async (
		scope: OrgScope,
		id: string,
		trust: HostKeyTrustUpdate,
	): Promise<HostRow | undefined> => {
		const label = requireNonBlankLabel(trust.hostKeyTrustedByLabel)
		return db
			.updateTable("host")
			.set({
				hostKeyTrustedBy: trust.hostKeyTrustedBy,
				hostKeyTrustedByLabel: label,
				hostKeyFingerprint: trust.hostKeyFingerprint,
				hostKeyAlgorithm: trust.hostKeyAlgorithm,
				hostKeyTrustedAt: trust.hostKeyTrustedAt,
				organizationId: scope.organizationId,
			})
			.where("id", "=", id)
			.where("organizationId", "=", scope.organizationId)
			.returningAll()
			.executeTakeFirst()
	},
})

export type HostRepository = ReturnType<typeof createHostRepository>
