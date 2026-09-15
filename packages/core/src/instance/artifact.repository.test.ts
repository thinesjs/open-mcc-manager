import { randomUUID } from "node:crypto"
import type { INSTANCE_ARTIFACT_KINDS } from "@open-mcc/contracts"
import { createDb, createMigrator, type InstanceArtifactKind } from "@open-mcc/db"
import { sql } from "kysely"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { seedOrganization, teardownTestDb, testDb, trackHostId, trackInstanceId } from "../test/db"
import { createPlayerListHost, fingerprintOf } from "../test/player-list-host"
import {
	type ArtifactStore,
	type CollectedArtifact,
	digestOf,
	EMPTY_FINGERPRINT,
	PLAYER_LIST_FILE_DEFAULT,
	sweepHostArtifacts,
} from "./artifact"
import { createArtifactRepository } from "./artifact.repository"

const repo = createArtifactRepository(testDb())

let ownerOrg = ""
let otherOrg = ""
let ownerInstance = ""
let otherInstance = ""

type RefinementOf<Narrowed extends Base, Base> = Narrowed

type _DatabaseKindsMatchTheContract = RefinementOf<
	InstanceArtifactKind,
	(typeof INSTANCE_ARTIFACT_KINDS)[number]
>

type _ContractKindsMatchTheDatabase = RefinementOf<
	(typeof INSTANCE_ARTIFACT_KINDS)[number],
	InstanceArtifactKind
>

const seedInstance = async (organizationId: string, port: number): Promise<string> => {
	const hostId = `host-${Math.random().toString(36).slice(2, 10)}`
	await testDb()
		.insertInto("host")
		.values({ id: hostId, organizationId, name: hostId, hostname: "10.0.0.1" })
		.execute()
	trackHostId(hostId)
	const row = await testDb()
		.insertInto("instance")
		.values({
			id: `inst-${Math.random().toString(36).slice(2, 10)}`,
			organizationId,
			hostId,
			name: `afk-${port}`,
			minecraftAccount: "a@b.com",
			minecraftUsername: null,
			liveControlPort: port,
		})
		.returningAll()
		.executeTakeFirstOrThrow()
	trackInstanceId(row.id)
	return row.id
}

const keep = async (
	organizationId: string,
	instanceId: string,
	content: Buffer,
	collectedAt: Date,
	kind: InstanceArtifactKind = "playerList",
) =>
	await repo.store(
		{ organizationId },
		{ instanceId, kind, content, digest: content.toString("hex"), collectedAt },
	)

const cursorOf = async (instanceId: string) =>
	await testDb()
		.selectFrom("instance")
		.select(["playerListOffset", "playerListFingerprint", "playerListCursorVersion"])
		.where("id", "=", instanceId)
		.executeTakeFirstOrThrow()

const storedContents = async (instanceId: string): Promise<readonly string[]> =>
	(
		await testDb()
			.selectFrom("instanceArtifact")
			.select("content")
			.where("instanceId", "=", instanceId)
			.orderBy("collectedAt")
			.orderBy("id")
			.execute()
	).map((row) => row.content.toString())

const playerList = (instanceId: string, text: string) => {
	const content = Buffer.from(text)
	return {
		instanceId,
		kind: "playerList" as const,
		content,
		digest: digestOf(content),
		collectedAt: new Date(),
	}
}

const storeFor = (organizationId: string): ArtifactStore => {
	const scope = { organizationId }
	const values = (instanceId: string, artifact: CollectedArtifact) => ({
		instanceId,
		kind: artifact.kind,
		content: artifact.content,
		digest: artifact.digest,
		collectedAt: new Date(),
	})
	return {
		keep: async (instanceId, artifact) => {
			await repo.store(scope, values(instanceId, artifact))
		},
		storeAndAdvance: async (instanceId, artifact, advance) => {
			await repo.storeAndAdvance(scope, values(instanceId, artifact), advance)
		},
		resetCursor: async (instanceId, version) => await repo.resetCursor(scope, instanceId, version),
	}
}

beforeAll(async () => {
	ownerOrg = await seedOrganization("artifact-owner")
	otherOrg = await seedOrganization("artifact-other")
	ownerInstance = await seedInstance(ownerOrg, 34401)
	otherInstance = await seedInstance(otherOrg, 34402)
})

afterAll(async () => {
	await teardownTestDb()
})

describe("keeping what a host wrote", () => {
	it("stores the bytes unchanged, so a binary replay survives the round trip", async () => {
		const content = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff, 0x7f, 0x80])
		expect(await keep(ownerOrg, ownerInstance, content, new Date(), "replay")).toBe(true)

		const stored = await repo.listSummaries({ organizationId: ownerOrg }, ownerInstance)
		const replay = stored.find((row) => row.kind === "replay")
		if (replay === undefined) throw new Error("expected the replay back")
		expect(replay.byteSize).toBe(content.length)
		expect(await repo.contentOf({ organizationId: ownerOrg }, replay.id)).toEqual(content)
	})

	it("keeps the same bytes once, so a removal that failed cannot double them on the next sweep", async () => {
		const content = Buffer.from("alice, bob\n")
		expect(await keep(ownerOrg, ownerInstance, content, new Date())).toBe(true)
		expect(await keep(ownerOrg, ownerInstance, content, new Date())).toBe(false)

		const stored = await repo.listSummaries({ organizationId: ownerOrg }, ownerInstance)
		expect(stored.filter((row) => row.byteSize === content.length)).toHaveLength(1)
	})

	it("shows one organization nothing another organization collected", async () => {
		const content = Buffer.from("their roster\n")
		await keep(otherOrg, otherInstance, content, new Date())

		expect(await repo.listSummaries({ organizationId: ownerOrg }, otherInstance)).toHaveLength(0)
		const theirs = await repo.listSummaries({ organizationId: otherOrg }, otherInstance)
		const first = theirs[0]
		if (first === undefined) throw new Error("expected their own row back")
		expect(await repo.contentOf({ organizationId: ownerOrg }, first.id)).toBeUndefined()
	})
})

describe("★ moving a player list's cursor only with the bytes it stored", () => {
	it("refuses a commit read before a truncate and reset, and keeps no row of what it read", async () => {
		const instanceId = await seedInstance(ownerOrg, 34406)
		const scope = { organizationId: ownerOrg }
		const first = playerList(instanceId, "[2026/9/15 10:0]\nalice\n\n")
		await repo.storeAndAdvance(scope, first, {
			offset: 0,
			fingerprint: digestOf(first.content),
			version: 0,
		})
		expect(await cursorOf(instanceId)).toEqual({
			playerListOffset: String(first.content.length),
			playerListFingerprint: digestOf(first.content),
			playerListCursorVersion: "1",
		})

		const stale = playerList(instanceId, "[2026/9/15 11:0]\nbob\n\n")
		expect(await repo.resetCursor(scope, instanceId, 1)).toBe(true)
		await expect(
			repo.storeAndAdvance(scope, stale, {
				offset: first.content.length,
				fingerprint: fingerprintOf(Buffer.concat([first.content, stale.content]), 45),
				version: 1,
			}),
		).rejects.toThrow()

		expect(await cursorOf(instanceId)).toEqual({
			playerListOffset: "0",
			playerListFingerprint: EMPTY_FINGERPRINT,
			playerListCursorVersion: "2",
		})
		expect(await storedContents(instanceId)).toEqual([first.content.toString()])
		expect(await repo.resetCursor(scope, instanceId, 1)).toBe(false)
	})

	it("advances past bytes it already holds without storing them twice", async () => {
		const instanceId = await seedInstance(ownerOrg, 34407)
		const scope = { organizationId: ownerOrg }
		const same = playerList(instanceId, "[2026/9/15 10:0]\n\n")
		const length = same.content.length

		await repo.storeAndAdvance(scope, same, { offset: 0, fingerprint: "a".repeat(64), version: 0 })
		await repo.storeAndAdvance(scope, same, {
			offset: length,
			fingerprint: "b".repeat(64),
			version: 1,
		})

		expect(await cursorOf(instanceId)).toEqual({
			playerListOffset: String(2 * length),
			playerListFingerprint: "b".repeat(64),
			playerListCursorVersion: "2",
		})
		expect(await storedContents(instanceId)).toEqual([same.content.toString()])
	})

	it("moves no other organization's cursor", async () => {
		const instanceId = await seedInstance(ownerOrg, 34409)
		const theirs = { organizationId: otherOrg }

		expect(await repo.resetCursor(theirs, instanceId, 0)).toBe(false)
		await expect(
			repo.storeAndAdvance(theirs, playerList(instanceId, "x\n"), {
				offset: 0,
				fingerprint: "c".repeat(64),
				version: 0,
			}),
		).rejects.toThrow()
		expect((await cursorOf(instanceId)).playerListCursorVersion).toBe("0")
	})

	it("★ resets a list truncated and regrown in the same inode, then collects it again from the start", async () => {
		const instanceId = await seedInstance(ownerOrg, 34408)
		const before = Buffer.from("[2026/9/15 10:0]\nalice\n\n")
		const after = Buffer.from("[2026/9/15 12:0]\ncarol, dave\n\n")
		const host = createPlayerListHost(instanceId, PLAYER_LIST_FILE_DEFAULT, {
			content: before,
			unit: "active",
			auth: "inactive",
		})
		const sweep = async () =>
			await sweepHostArtifacts(
				host.transport,
				[
					await testDb()
						.selectFrom("instance")
						.selectAll()
						.where("id", "=", instanceId)
						.executeTakeFirstOrThrow(),
				],
				new Map(),
				storeFor(ownerOrg),
			)

		await sweep()
		host.content = after
		await sweep()

		expect(await storedContents(instanceId)).toEqual([before.toString(), after.toString()])
		expect(await cursorOf(instanceId)).toEqual({
			playerListOffset: String(after.length),
			playerListFingerprint: fingerprintOf(after, after.length),
			playerListCursorVersion: "3",
		})
	})

	it("★ leaves every existing bot at offset 0, the empty fingerprint and version 0 when it adds the cursor", async () => {
		const name = `cursor_migration_${randomUUID().replaceAll("-", "")}`
		await sql`create database ${sql.id(name)}`.execute(testDb())
		const url = new URL(process.env.TEST_DATABASE_URL ?? "")
		url.pathname = `/${name}`
		const fresh = createDb(url.toString())
		try {
			const migrator = createMigrator(fresh)
			const names = (await migrator.getMigrations()).map((migration) => migration.name)
			const cursorAt = names.findIndex((each) => each.endsWith("_player_list_cursor.sql"))
			expect(cursorAt).toBeGreaterThan(0)
			expect((await migrator.migrateTo(names[cursorAt - 1] ?? "")).error).toBeUndefined()
			await sql`insert into "organization" ("id", "name", "slug") values ('org', 'org', 'org')`.execute(
				fresh,
			)
			await sql`insert into "host" ("id", "organizationId", "name", "hostname") values ('host', 'org', 'host', '10.0.0.1')`.execute(
				fresh,
			)
			await sql`insert into "instance" ("id", "organizationId", "hostId", "name", "minecraftAccount", "liveControlPort") values ('bot', 'org', 'host', 'bot', 'a@b.com', 34999)`.execute(
				fresh,
			)

			expect((await migrator.migrateToLatest()).error).toBeUndefined()

			expect(
				await fresh
					.selectFrom("instance")
					.select(["playerListOffset", "playerListFingerprint", "playerListCursorVersion"])
					.where("id", "=", "bot")
					.executeTakeFirstOrThrow(),
			).toEqual({
				playerListOffset: "0",
				playerListFingerprint: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
				playerListCursorVersion: "0",
			})
			await expect(
				sql`update "instance" set "playerListOffset" = -1 where "id" = 'bot'`.execute(fresh),
			).rejects.toThrow()
		} finally {
			await fresh.destroy()
			await sql`drop database ${sql.id(name)} with (force)`.execute(testDb())
		}
	})
})

describe("bounding what the control plane holds", () => {
	it("drops everything past the number of artifacts kept for a kind", async () => {
		const instanceId = await seedInstance(ownerOrg, 34403)
		for (let index = 0; index < 5; index += 1) {
			await keep(ownerOrg, instanceId, Buffer.from(`roster ${index}\n`), new Date(1000 + index))
		}

		expect(
			await repo.deleteBeyondKept({ organizationId: ownerOrg }, instanceId, "playerList", 2),
		).toBe(3)
		const left = await repo.listSummaries({ organizationId: ownerOrg }, instanceId)
		expect(left).toHaveLength(2)
		expect(left.map((row) => row.collectedAt)).toEqual([new Date(1004), new Date(1003)])
	})

	it("counts only the kind it was asked to bound", async () => {
		const instanceId = await seedInstance(ownerOrg, 34404)
		await keep(ownerOrg, instanceId, Buffer.from("roster\n"), new Date(2000))
		await keep(ownerOrg, instanceId, Buffer.from("replay"), new Date(2001), "replay")

		expect(
			await repo.deleteBeyondKept({ organizationId: ownerOrg }, instanceId, "playerList", 0),
		).toBe(1)
		expect(await repo.listSummaries({ organizationId: ownerOrg }, instanceId)).toHaveLength(1)
	})

	it("removes everything collected before the retention cutoff", async () => {
		const instanceId = await seedInstance(ownerOrg, 34405)
		await keep(ownerOrg, instanceId, Buffer.from("old\n"), new Date(1_000_000))
		await keep(ownerOrg, instanceId, Buffer.from("new\n"), new Date(9_000_000))

		expect(
			await repo.deleteCollectedBefore({ organizationId: ownerOrg }, new Date(5_000_000)),
		).toBeGreaterThanOrEqual(1)
		const left = await repo.listSummaries({ organizationId: ownerOrg }, instanceId)
		expect(left.map((row) => row.collectedAt)).toEqual([new Date(9_000_000)])
	})

	it("leaves another organization's rows alone when one organization's retention runs", async () => {
		const theirs = await keep(otherOrg, otherInstance, Buffer.from("keep me\n"), new Date(1_000))
		expect(theirs).toBe(true)

		await repo.deleteCollectedBefore({ organizationId: ownerOrg }, new Date(9_999_999))

		const left = await repo.listSummaries({ organizationId: otherOrg }, otherInstance)
		expect(left.some((row) => row.collectedAt.getTime() === 1_000)).toBe(true)
	})
})
