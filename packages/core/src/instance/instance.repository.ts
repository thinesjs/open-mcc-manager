import { AUTH_LEASE_MS } from "@open-mcc/contracts"
import type { Executor, InstanceConfigRow, InstanceInsert, InstanceRow } from "@open-mcc/db"
import { sql } from "kysely"
import { nanoid } from "nanoid"
import type { SealedValue } from "../crypto/sealed-box"
import type { OrgScope } from "../host/host.repository"
import { InternalError } from "../lib/errors"

export type InstanceCreateValues = Omit<
	InstanceInsert,
	| "id"
	| "organizationId"
	| "createdAt"
	| "authClaimId"
	| "authClaimedAt"
	| "configClaimId"
	| "configClaimedAt"
>

const MUTABLE_INSTANCE_COLUMNS = [
	"name",
	"status",
	"lastExitCode",
	"minecraftUsername",
	"liveControlTokenEncrypted",
	"liveControlTokenKeyId",
] as const

export type InstanceUpdateValues = Partial<
	Pick<InstanceRow, (typeof MUTABLE_INSTANCE_COLUMNS)[number]>
>

export { AUTH_LEASE_MS }

export const CONFIG_CLAIM_LEASE_MS = 180_000

export const isAuthClaimStale = (claimedAt: Date | null, now: Date = new Date()): boolean =>
	claimedAt === null || now.getTime() - claimedAt.getTime() > AUTH_LEASE_MS

const databaseClock = sql<Date>`clock_timestamp()`

const leasedBefore = (leaseMs: number) =>
	sql<Date>`clock_timestamp() - ${sql.lit(leaseMs)} * interval '1 millisecond'`

const whitelistInstanceUpdate = (patch: InstanceUpdateValues): InstanceUpdateValues => ({
	...(patch.name !== undefined && { name: patch.name }),
	...(patch.status !== undefined && { status: patch.status }),
	...(patch.minecraftUsername !== undefined && { minecraftUsername: patch.minecraftUsername }),
	...(patch.lastExitCode !== undefined && { lastExitCode: patch.lastExitCode }),
	...(patch.liveControlTokenEncrypted !== undefined && {
		liveControlTokenEncrypted: patch.liveControlTokenEncrypted,
	}),
	...(patch.liveControlTokenKeyId !== undefined && {
		liveControlTokenKeyId: patch.liveControlTokenKeyId,
	}),
})

export const createInstanceRepository = (db: Executor) => ({
	insert: async (
		scope: OrgScope,
		values: InstanceCreateValues,
		claimId: string,
	): Promise<InstanceRow> => {
		const row = await db
			.insertInto("instance")
			.values({
				...values,
				id: nanoid(),
				organizationId: scope.organizationId,
				configClaimId: claimId,
				configClaimedAt: databaseClock,
			})
			.returningAll()
			.executeTakeFirst()
		if (!row) throw new InternalError("Instance insert returned no row")
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
			.set({
				authClaimId: attemptId,
				authClaimedAt: new Date(),
				configClaimId: null,
				configClaimedAt: null,
			})
			.where("id", "=", id)
			.where("organizationId", "=", scope.organizationId)
			.where((eb) =>
				eb.or([
					eb("authClaimId", "is", null),
					eb("authClaimedAt", "<", new Date(Date.now() - AUTH_LEASE_MS)),
				]),
			)
			.where((eb) =>
				eb.or([
					eb("configClaimId", "is", null),
					eb("configClaimedAt", "<", leasedBefore(CONFIG_CLAIM_LEASE_MS)),
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

	claimForConfig: async (
		scope: OrgScope,
		id: string,
		claimId: string,
	): Promise<InstanceRow | undefined> =>
		db
			.updateTable("instance")
			.set({ configClaimId: claimId, configClaimedAt: databaseClock })
			.where("id", "=", id)
			.where("organizationId", "=", scope.organizationId)
			.where((eb) =>
				eb.or([
					eb("configClaimId", "is", null),
					eb("configClaimedAt", "<", leasedBefore(CONFIG_CLAIM_LEASE_MS)),
				]),
			)
			.returningAll()
			.executeTakeFirst(),

	claimForLifecycle: async (
		scope: OrgScope,
		id: string,
		claimId: string,
	): Promise<InstanceRow | undefined> =>
		db
			.updateTable("instance")
			.set({ configClaimId: claimId, configClaimedAt: databaseClock })
			.where("id", "=", id)
			.where("organizationId", "=", scope.organizationId)
			.where((eb) =>
				eb.or([
					eb("configClaimId", "is", null),
					eb("configClaimedAt", "<", leasedBefore(CONFIG_CLAIM_LEASE_MS)),
				]),
			)
			.where((eb) =>
				eb.or([
					eb("authClaimId", "is", null),
					eb("authClaimedAt", "<", new Date(Date.now() - AUTH_LEASE_MS)),
				]),
			)
			.returningAll()
			.executeTakeFirst(),

	finalizeConfigClaim: async (
		scope: OrgScope,
		id: string,
		claimId: string,
		patch: Pick<InstanceUpdateValues, "status">,
	): Promise<InstanceRow | undefined> =>
		db
			.updateTable("instance")
			.set({
				...(patch.status !== undefined && { status: patch.status }),
				configClaimId: null,
				configClaimedAt: null,
			})
			.where("id", "=", id)
			.where("organizationId", "=", scope.organizationId)
			.where("configClaimId", "=", claimId)
			.returningAll()
			.executeTakeFirst(),

	releaseConfigClaim: async (scope: OrgScope, id: string, claimId: string): Promise<boolean> => {
		const rows = await db
			.updateTable("instance")
			.set({ configClaimId: null, configClaimedAt: null })
			.where("id", "=", id)
			.where("organizationId", "=", scope.organizationId)
			.where("configClaimId", "=", claimId)
			.returningAll()
			.execute()
		return rows.length > 0
	},

	writeTokenUnderClaim: async (
		scope: OrgScope,
		id: string,
		claimId: string,
		sealed: SealedValue,
	): Promise<boolean> => {
		const rows = await db
			.updateTable("instance")
			.set({
				liveControlTokenEncrypted: sealed.ciphertext,
				liveControlTokenKeyId: sealed.keyId,
				configClaimedAt: databaseClock,
			})
			.where("id", "=", id)
			.where("organizationId", "=", scope.organizationId)
			.where("configClaimId", "=", claimId)
			.returningAll()
			.execute()
		return rows.length > 0
	},

	deleteUnderClaim: async (scope: OrgScope, id: string, claimId: string): Promise<boolean> => {
		const rows = await db
			.deleteFrom("instance")
			.where("id", "=", id)
			.where("organizationId", "=", scope.organizationId)
			.where("configClaimId", "=", claimId)
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
		if (!row) throw new InternalError("Instance config insert returned no row")
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

export type InstanceRepository = ReturnType<typeof createInstanceRepository>
