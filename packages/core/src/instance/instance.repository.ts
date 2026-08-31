import type { Executor, InstanceConfigRow, InstanceInsert, InstanceRow } from "@open-mcc/db"
import { nanoid } from "nanoid"
import type { OrgScope } from "../host/host.repository"

export type InstanceCreateValues = Omit<
	InstanceInsert,
	"id" | "organizationId" | "createdAt" | "authClaimId" | "authClaimedAt"
>

const MUTABLE_INSTANCE_COLUMNS = ["name", "status", "lastExitCode"] as const

export type InstanceUpdateValues = Partial<
	Pick<InstanceRow, (typeof MUTABLE_INSTANCE_COLUMNS)[number]>
>

export const AUTH_LEASE_MS = 15 * 60 * 1000

export const isAuthClaimStale = (claimedAt: Date | null, now: Date = new Date()): boolean =>
	claimedAt === null || now.getTime() - claimedAt.getTime() > AUTH_LEASE_MS

const whitelistInstanceUpdate = (patch: InstanceUpdateValues): InstanceUpdateValues => ({
	...(patch.name !== undefined && { name: patch.name }),
	...(patch.status !== undefined && { status: patch.status }),
	...(patch.lastExitCode !== undefined && { lastExitCode: patch.lastExitCode }),
})

export const createInstanceRepository = (db: Executor) => ({
	insert: async (scope: OrgScope, values: InstanceCreateValues): Promise<InstanceRow> => {
		const row = await db
			.insertInto("instance")
			.values({ ...values, id: nanoid(), organizationId: scope.organizationId })
			.returningAll()
			.executeTakeFirst()
		if (!row) throw new Error("Instance insert returned no row")
		return row
	},

	findById: async (scope: OrgScope, id: string): Promise<InstanceRow | undefined> =>
		db
			.selectFrom("instance")
			.selectAll()
			.where("id", "=", id)
			.where("organizationId", "=", scope.organizationId)
			.executeTakeFirst(),

	list: async (scope: OrgScope): Promise<InstanceRow[]> =>
		db
			.selectFrom("instance")
			.selectAll()
			.where("organizationId", "=", scope.organizationId)
			.orderBy("createdAt", "desc")
			.execute(),

	update: async (
		scope: OrgScope,
		id: string,
		patch: InstanceUpdateValues,
	): Promise<InstanceRow | undefined> =>
		db
			.updateTable("instance")
			.set({ ...whitelistInstanceUpdate(patch), organizationId: scope.organizationId })
			.where("id", "=", id)
			.where("organizationId", "=", scope.organizationId)
			.returningAll()
			.executeTakeFirst(),

	delete: async (scope: OrgScope, id: string): Promise<boolean> => {
		const rows = await db
			.deleteFrom("instance")
			.where("id", "=", id)
			.where("organizationId", "=", scope.organizationId)
			.returningAll()
			.execute()
		return rows.length > 0
	},

	claimForAuth: async (
		scope: OrgScope,
		id: string,
		attemptId: string,
	): Promise<InstanceRow | undefined> =>
		db
			.updateTable("instance")
			.set({ authClaimId: attemptId, authClaimedAt: new Date() })
			.where("id", "=", id)
			.where("organizationId", "=", scope.organizationId)
			.where((eb) =>
				eb.or([
					eb("authClaimId", "is", null),
					eb("authClaimedAt", "<", new Date(Date.now() - AUTH_LEASE_MS)),
				]),
			)
			.returningAll()
			.executeTakeFirst(),

	releaseAuthClaim: async (scope: OrgScope, id: string, attemptId: string): Promise<boolean> => {
		const rows = await db
			.updateTable("instance")
			.set({ authClaimId: null, authClaimedAt: null })
			.where("id", "=", id)
			.where("organizationId", "=", scope.organizationId)
			.where("authClaimId", "=", attemptId)
			.returningAll()
			.execute()
		return rows.length > 0
	},

	insertConfigVersion: async (
		scope: OrgScope,
		instanceId: string,
		document: string,
		author: { authorId: string | null; authorLabel: string },
	): Promise<InstanceConfigRow> => {
		const latest = await db
			.selectFrom("instanceConfig")
			.select("version")
			.where("instanceId", "=", instanceId)
			.where("organizationId", "=", scope.organizationId)
			.orderBy("version", "desc")
			.executeTakeFirst()
		const row = await db
			.insertInto("instanceConfig")
			.values({
				id: nanoid(),
				organizationId: scope.organizationId,
				instanceId,
				version: (latest?.version ?? 0) + 1,
				document,
				authorId: author.authorId,
				authorLabel: author.authorLabel,
			})
			.returningAll()
			.executeTakeFirst()
		if (!row) throw new Error("Instance config insert returned no row")
		return row
	},

	latestConfig: async (
		scope: OrgScope,
		instanceId: string,
	): Promise<InstanceConfigRow | undefined> =>
		db
			.selectFrom("instanceConfig")
			.selectAll()
			.where("instanceId", "=", instanceId)
			.where("organizationId", "=", scope.organizationId)
			.orderBy("version", "desc")
			.executeTakeFirst(),
})
