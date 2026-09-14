import { randomUUID } from "node:crypto"
import { createDb, type Db, migrateToLatest } from "@open-mcc/db"
import { sql } from "kysely"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import { createUpdateStateRepository } from "./update-state.repository"

const adminUrl = process.env.TEST_DATABASE_URL ?? ""
const databaseName = `update_state_test_${randomUUID().replaceAll("-", "")}`

let admin: Db
let db: Db

beforeAll(async () => {
	admin = createDb(adminUrl)
	await sql.raw(`create database "${databaseName}"`).execute(admin)
	const url = new URL(adminUrl)
	url.pathname = `/${databaseName}`
	db = createDb(url.toString())
	const { error } = await migrateToLatest(db)
	if (error) throw error
})

afterEach(async () => {
	await db.deleteFrom("updateState").execute()
})

afterAll(async () => {
	await db.destroy()
	await sql.raw(`drop database "${databaseName}" with (force)`).execute(admin)
	await admin.destroy()
})

const SOURCE = { owner: "thinesjs", repo: "open-mcc-manager" }

const FIRST_CHECK = new Date("2026-09-13T06:41:00Z")
const SECOND_CHECK = new Date("2026-09-13T12:41:00Z")

const RELEASE = { version: "1.5.0", notes: "## Fixes", notesTruncated: false }

const insertRaw = async (id: string, outcome: string) =>
	await sql`insert into "updateState" ("id", "sourceOwner", "sourceRepo", "checkedAt", "checkOutcome") values (${id}, 'thinesjs', 'open-mcc-manager', now(), ${outcome})`.execute(
		db,
	)

describe("the deployment's one update-state row", () => {
	it("has nothing to report before the first check", async () => {
		expect(await createUpdateStateRepository(db).find()).toBeUndefined()
	})

	it("keeps a single row however many checks it records", async () => {
		const states = createUpdateStateRepository(db)
		await states.recordCheck(SOURCE, FIRST_CHECK, { outcome: "ok", release: RELEASE })
		await states.recordCheck(SOURCE, SECOND_CHECK, { outcome: "unreachable" })

		const rows = await db.selectFrom("updateState").select("id").execute()
		expect(rows).toEqual([{ id: "singleton" }])
	})

	it("refuses a second row, so the deployment cannot hold two answers", async () => {
		await insertRaw("singleton", "ok")

		await expect(insertRaw("another", "ok")).rejects.toThrow("updateState_singleton")
	})

	it("refuses a check outcome it does not know", async () => {
		await expect(insertRaw("singleton", "maybe")).rejects.toThrow("updateState_check_outcome_known")
	})

	it("records the source it checked and the release it found", async () => {
		const states = createUpdateStateRepository(db)
		await states.recordCheck(SOURCE, FIRST_CHECK, {
			outcome: "ok",
			release: { version: "1.5.0", notes: "long notes…", notesTruncated: true },
		})

		expect(await states.find()).toMatchObject({
			sourceOwner: "thinesjs",
			sourceRepo: "open-mcc-manager",
			checkedAt: FIRST_CHECK,
			checkOutcome: "ok",
			latestVersion: "1.5.0",
			latestNotes: "long notes…",
			notesTruncated: true,
			rateLimitedUntil: null,
		})
	})

	it("keeps the last release it found when a later check fails", async () => {
		const states = createUpdateStateRepository(db)
		await states.recordCheck(SOURCE, FIRST_CHECK, { outcome: "ok", release: RELEASE })
		await states.recordCheck(SOURCE, SECOND_CHECK, { outcome: "not-found" })

		expect(await states.find()).toMatchObject({
			checkedAt: SECOND_CHECK,
			checkOutcome: "not-found",
			latestVersion: "1.5.0",
			latestNotes: "## Fixes",
		})
	})

	it("replaces the whole release when a later check finds another", async () => {
		const states = createUpdateStateRepository(db)
		await states.recordCheck(SOURCE, FIRST_CHECK, {
			outcome: "ok",
			release: { version: "1.5.0", notes: "long notes…", notesTruncated: true },
		})
		await states.recordCheck(SOURCE, SECOND_CHECK, {
			outcome: "ok",
			release: { version: "1.6.0", notes: null, notesTruncated: false },
		})

		expect(await states.find()).toMatchObject({
			latestVersion: "1.6.0",
			latestNotes: null,
			notesTruncated: false,
		})
	})

	it("records when a rate limit ends, and forgets it on the next check", async () => {
		const states = createUpdateStateRepository(db)
		const until = new Date("2026-09-13T07:00:00Z")
		await states.recordCheck(SOURCE, FIRST_CHECK, { outcome: "rate-limited", until })
		expect((await states.find())?.rateLimitedUntil).toEqual(until)

		await states.recordCheck(SOURCE, SECOND_CHECK, { outcome: "unreachable" })
		expect((await states.find())?.rateLimitedUntil).toBeNull()
	})
})
