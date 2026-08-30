import { randomUUID } from "node:crypto"
import { type Executor, type HostInsert, type HostRow, host } from "@open-mcc/db"
import { and, eq, isNull, lt, or, sql } from "drizzle-orm"

export type OrgScope = { organizationId: string }

export type HostCreateValues = Omit<HostInsert, "id" | "organizationId" | "createdAt">

const MUTABLE_HOST_COLUMNS = [
	"name",
	"hostname",
	"port",
	"username",
	"sshKeyId",
	"status",
	"dockerVersion",
	"osRelease",
	"cpuCount",
	"memoryMb",
	"capacityLimit",
	"lastSeenAt",
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

export const PROVISIONING_LEASE_MS = 5 * 60 * 1000

export const isProvisioningClaimStale = (claimedAt: Date | null, now: Date = new Date()): boolean =>
	claimedAt === null || now.getTime() - claimedAt.getTime() > PROVISIONING_LEASE_MS

const whitelistHostUpdate = (patch: HostUpdateValues): HostUpdateValues => ({
	...(patch.name !== undefined && { name: patch.name }),
	...(patch.hostname !== undefined && { hostname: patch.hostname }),
	...(patch.port !== undefined && { port: patch.port }),
	...(patch.username !== undefined && { username: patch.username }),
	...(patch.sshKeyId !== undefined && { sshKeyId: patch.sshKeyId }),
	...(patch.status !== undefined && { status: patch.status }),
	...(patch.dockerVersion !== undefined && { dockerVersion: patch.dockerVersion }),
	...(patch.osRelease !== undefined && { osRelease: patch.osRelease }),
	...(patch.cpuCount !== undefined && { cpuCount: patch.cpuCount }),
	...(patch.memoryMb !== undefined && { memoryMb: patch.memoryMb }),
	...(patch.capacityLimit !== undefined && { capacityLimit: patch.capacityLimit }),
	...(patch.lastSeenAt !== undefined && { lastSeenAt: patch.lastSeenAt }),
})

export const createHostRepository = (db: Executor) => ({
	insert: async (scope: OrgScope, values: HostCreateValues): Promise<HostRow> => {
		requireConsistentTrustTuple(values)
		const rows = await db
			.insert(host)
			.values({
				...values,
				organizationId: scope.organizationId,
				hostKeyTrustedByLabel: resolveHostKeyTrustedByLabel(values),
			})
			.returning()
		const row = rows[0]
		if (!row) throw new Error("Host insert returned no row")
		return row
	},

	findById: async (scope: OrgScope, id: string): Promise<HostRow | undefined> => {
		const rows = await db
			.select()
			.from(host)
			.where(and(eq(host.id, id), eq(host.organizationId, scope.organizationId)))
			.limit(1)
		return rows[0]
	},

	list: async (scope: OrgScope): Promise<HostRow[]> =>
		db.select().from(host).where(eq(host.organizationId, scope.organizationId)),

	update: async (
		scope: OrgScope,
		id: string,
		patch: HostUpdateValues,
	): Promise<HostRow | undefined> => {
		const rows = await db
			.update(host)
			.set({ ...whitelistHostUpdate(patch), organizationId: scope.organizationId })
			.where(and(eq(host.id, id), eq(host.organizationId, scope.organizationId)))
			.returning()
		return rows[0]
	},

	delete: async (scope: OrgScope, id: string): Promise<boolean> => {
		const rows = await db
			.delete(host)
			.where(and(eq(host.id, id), eq(host.organizationId, scope.organizationId)))
			.returning()
		return rows.length > 0
	},

	lockHost: async (id: string): Promise<void> => {
		await db.execute(sql`select pg_advisory_xact_lock(hashtextextended(${id}, 0))`)
	},

	claimForProvisioning: async (
		scope: OrgScope,
		id: string,
		expectedStatus: HostRow["status"],
	): Promise<HostRow | undefined> => {
		const now = new Date()
		const staleBefore = new Date(now.getTime() - PROVISIONING_LEASE_MS)
		const staleClaimCondition = and(
			eq(host.status, "provisioning"),
			or(isNull(host.provisioningClaimedAt), lt(host.provisioningClaimedAt, staleBefore)),
		)
		const statusCondition =
			expectedStatus === "provisioning"
				? staleClaimCondition
				: or(eq(host.status, expectedStatus), staleClaimCondition)

		const rows = await db
			.update(host)
			.set({
				status: "provisioning",
				provisioningAttemptId: randomUUID(),
				provisioningClaimedAt: now,
				organizationId: scope.organizationId,
			})
			.where(and(eq(host.id, id), eq(host.organizationId, scope.organizationId), statusCondition))
			.returning()
		return rows[0]
	},

	finalizeProvisioning: async (
		scope: OrgScope,
		id: string,
		attemptId: string,
		patch: Pick<HostUpdateValues, "status" | "dockerVersion">,
	): Promise<HostRow | undefined> => {
		const rows = await db
			.update(host)
			.set({
				...patch,
				provisioningAttemptId: null,
				provisioningClaimedAt: null,
				organizationId: scope.organizationId,
			})
			.where(
				and(
					eq(host.id, id),
					eq(host.organizationId, scope.organizationId),
					eq(host.status, "provisioning"),
					eq(host.provisioningAttemptId, attemptId),
				),
			)
			.returning()
		return rows[0]
	},

	updateHostKeyTrust: async (
		scope: OrgScope,
		id: string,
		trust: HostKeyTrustUpdate,
	): Promise<HostRow | undefined> => {
		const label = requireNonBlankLabel(trust.hostKeyTrustedByLabel)
		const rows = await db
			.update(host)
			.set({
				hostKeyTrustedBy: trust.hostKeyTrustedBy,
				hostKeyTrustedByLabel: label,
				hostKeyFingerprint: trust.hostKeyFingerprint,
				hostKeyAlgorithm: trust.hostKeyAlgorithm,
				hostKeyTrustedAt: trust.hostKeyTrustedAt,
				organizationId: scope.organizationId,
			})
			.where(and(eq(host.id, id), eq(host.organizationId, scope.organizationId)))
			.returning()
		return rows[0]
	},
})

export type HostRepository = ReturnType<typeof createHostRepository>
