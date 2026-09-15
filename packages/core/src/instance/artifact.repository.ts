import type { Db, Executor, InstanceArtifactKind } from "@open-mcc/db"
import { nanoid } from "nanoid"
import type { OrgScope } from "../host/host.repository"
import { type CursorAdvance, EMPTY_FINGERPRINT } from "./artifact"

export type ArtifactValues = {
	instanceId: string
	kind: InstanceArtifactKind
	content: Buffer
	digest: string
	collectedAt: Date
}

export type ArtifactSummary = {
	id: string
	instanceId: string
	kind: InstanceArtifactKind
	byteSize: number
	collectedAt: Date
}

const insertArtifact = async (
	executor: Executor,
	scope: OrgScope,
	values: ArtifactValues,
): Promise<boolean> => {
	const row = await executor
		.insertInto("instanceArtifact")
		.values({
			id: nanoid(),
			organizationId: scope.organizationId,
			instanceId: values.instanceId,
			kind: values.kind,
			content: values.content,
			digest: values.digest,
			byteSize: values.content.length,
			collectedAt: values.collectedAt,
		})
		.onConflict((conflict) =>
			conflict.columns(["organizationId", "instanceId", "kind", "digest"]).doNothing(),
		)
		.returning("id")
		.executeTakeFirst()
	return row !== undefined
}

export const createArtifactRepository = (db: Db) => ({
	store: async (scope: OrgScope, values: ArtifactValues): Promise<boolean> =>
		await insertArtifact(db, scope, values),

	storeAndAdvance: async (
		scope: OrgScope,
		values: ArtifactValues,
		advance: CursorAdvance,
	): Promise<void> => {
		await db.transaction().execute(async (tx) => {
			await insertArtifact(tx, scope, values)
			const moved = await tx
				.updateTable("instance")
				.set({
					playerListOffset: advance.offset + values.content.length,
					playerListFingerprint: advance.fingerprint,
					playerListCursorVersion: advance.version + 1,
				})
				.where("organizationId", "=", scope.organizationId)
				.where("id", "=", values.instanceId)
				.where("playerListCursorVersion", "=", String(advance.version))
				.returning("id")
				.executeTakeFirst()
			if (moved === undefined) throw new Error("The player list cursor moved after it was read")
		})
	},

	resetCursor: async (scope: OrgScope, instanceId: string, version: number): Promise<boolean> => {
		const moved = await db
			.updateTable("instance")
			.set({
				playerListOffset: 0,
				playerListFingerprint: EMPTY_FINGERPRINT,
				playerListCursorVersion: version + 1,
			})
			.where("organizationId", "=", scope.organizationId)
			.where("id", "=", instanceId)
			.where("playerListCursorVersion", "=", String(version))
			.returning("id")
			.executeTakeFirst()
		return moved !== undefined
	},

	listSummaries: async (scope: OrgScope, instanceId: string): Promise<ArtifactSummary[]> =>
		db
			.selectFrom("instanceArtifact")
			.select(["id", "instanceId", "kind", "byteSize", "collectedAt"])
			.where("organizationId", "=", scope.organizationId)
			.where("instanceId", "=", instanceId)
			.orderBy("collectedAt", "desc")
			.orderBy("id", "desc")
			.execute(),

	contentOf: async (scope: OrgScope, id: string): Promise<Buffer | undefined> => {
		const row = await db
			.selectFrom("instanceArtifact")
			.select("content")
			.where("organizationId", "=", scope.organizationId)
			.where("id", "=", id)
			.executeTakeFirst()
		return row?.content
	},

	deleteCollectedBefore: async (scope: OrgScope, cutoff: Date): Promise<number> => {
		const result = await db
			.deleteFrom("instanceArtifact")
			.where("organizationId", "=", scope.organizationId)
			.where("collectedAt", "<", cutoff)
			.executeTakeFirst()
		return Number(result.numDeletedRows ?? 0n)
	},

	deleteBeyondKept: async (
		scope: OrgScope,
		instanceId: string,
		kind: InstanceArtifactKind,
		kept: number,
	): Promise<number> => {
		const stale = await db
			.selectFrom("instanceArtifact")
			.select("id")
			.where("organizationId", "=", scope.organizationId)
			.where("instanceId", "=", instanceId)
			.where("kind", "=", kind)
			.orderBy("collectedAt", "desc")
			.orderBy("id", "desc")
			.offset(kept)
			.execute()
		if (stale.length === 0) return 0
		const result = await db
			.deleteFrom("instanceArtifact")
			.where("organizationId", "=", scope.organizationId)
			.where(
				"id",
				"in",
				stale.map((row) => row.id),
			)
			.executeTakeFirst()
		return Number(result.numDeletedRows ?? 0n)
	},
})

export type ArtifactRepository = ReturnType<typeof createArtifactRepository>
