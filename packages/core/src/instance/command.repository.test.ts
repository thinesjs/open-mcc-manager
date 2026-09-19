import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { seedOrganization, teardownTestDb, testDb, trackHostId, trackInstanceId } from "../test/db"
import { createCommandRepository } from "./command.repository"

const repo = createCommandRepository(testDb())
let org = ""
let instanceId = ""

const values = (overrides: Partial<Parameters<typeof repo.upsert>[1]> = {}) => ({
	instanceId,
	name: "morning wave",
	command: "/say good morning",
	daysOfWeek: "Mon",
	minuteOfDay: 540,
	timezone: "UTC",
	enabled: true,
	...overrides,
})

beforeAll(async () => {
	org = await seedOrganization("cmd")
	const hostId = `host-${Math.random().toString(36).slice(2, 10)}`
	await testDb()
		.insertInto("host")
		.values({ id: hostId, organizationId: org, name: hostId, hostname: "10.0.0.1" })
		.execute()
	trackHostId(hostId)
	const row = await testDb()
		.insertInto("instance")
		.values({
			id: `inst-${Math.random().toString(36).slice(2, 10)}`,
			organizationId: org,
			hostId,
			name: "afk",
			minecraftAccount: "a@b.com",
			minecraftUsername: null,
			liveControlPort: 34333,
		})
		.returningAll()
		.executeTakeFirstOrThrow()
	trackInstanceId(row.id)
	instanceId = row.id
})

afterAll(async () => {
	await teardownTestDb()
})

describe("claiming a scheduled run", () => {
	it("lets exactly one of two concurrent claims win, so two schedulers cannot both send", async () => {
		const row = await repo.upsert({ organizationId: org }, values({ name: "concurrent" }))
		const at = new Date()
		const boundary = new Date(at.getTime() - 60_000)

		const [first, second] = await Promise.all([
			repo.claimRun(row.id, at, boundary),
			repo.claimRun(row.id, at, boundary),
		])

		expect([first, second].filter(Boolean)).toHaveLength(1)
	})

	it("refuses a second claim once the run is recorded for the day", async () => {
		const row = await repo.upsert({ organizationId: org }, values({ name: "once" }))
		const at = new Date()
		const boundary = new Date(at.getTime() - 60_000)

		expect(await repo.claimRun(row.id, at, boundary)).toBe(true)
		expect(await repo.claimRun(row.id, at, boundary)).toBe(false)
	})

	it("claims again once the boundary has moved past the previous run", async () => {
		const row = await repo.upsert({ organizationId: org }, values({ name: "nextday" }))
		const yesterday = new Date(Date.now() - 26 * 60 * 60 * 1000)

		expect(await repo.claimRun(row.id, yesterday, new Date(yesterday.getTime() - 60_000))).toBe(
			true,
		)
		expect(await repo.claimRun(row.id, new Date(), new Date(Date.now() - 60_000))).toBe(true)
	})

	it("clears the run marker when the schedule is edited, so the edit runs today", async () => {
		const row = await repo.upsert({ organizationId: org }, values({ name: "edited" }))
		await repo.claimRun(row.id, new Date(), new Date(Date.now() - 60_000))

		const edited = await repo.upsert(
			{ organizationId: org },
			values({ name: "edited", minuteOfDay: 600 }),
		)

		expect(edited.lastRunAt).toBeNull()
		expect(edited.lastRunError).toBeNull()
	})
})
