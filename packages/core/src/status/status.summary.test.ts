import { randomUUID } from "node:crypto"
import { STATUS_RANGES } from "@open-mcc/contracts"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { seedOrganization, teardownTestDb, testDb, trackHostId } from "../test/db"
import { createStatusController, createStatusControllerTransaction } from "./status.controller"

const now = new Date("2026-09-13T10:07:30Z")
const hostId = `host-${randomUUID()}`
let organizationId = ""

const controller = createStatusController({
	withTransaction: createStatusControllerTransaction(testDb()),
	sendJob: async () => "job",
	hostNames: async () => [{ id: hostId, name: "survival" }],
	instanceNames: async () => [],
	retentionDays: 30,
	now: () => now,
})

const interval = (state: "up" | "down", startedAt: string, endedAt: string | null) => ({
	id: randomUUID(),
	organizationId,
	hostId,
	instanceId: null,
	dimension: "host.reachability" as const,
	state,
	startedAt: new Date(startedAt),
	endedAt: endedAt === null ? null : new Date(endedAt),
	startEventId: null,
	endEventId: null,
})

beforeAll(async () => {
	organizationId = await seedOrganization("status-summary")
	await testDb()
		.insertInto("host")
		.values({ id: hostId, organizationId, name: hostId, hostname: "survival.example" })
		.execute()
	trackHostId(hostId)
	await testDb()
		.insertInto("statusInterval")
		.values([
			interval("up", "2026-08-01T00:00:00Z", "2026-09-13T08:00:00Z"),
			interval("down", "2026-09-13T08:00:00Z", "2026-09-13T08:10:00Z"),
			interval("up", "2026-09-13T08:10:00Z", null),
		])
		.execute()
})

afterAll(async () => {
	await teardownTestDb()
})

describe("the uptime summary, taken through the real controller and database", () => {
	it("draws about ninety bars for every range, spaced by the size it reports", async () => {
		for (const [range, count] of [
			["24h", 96],
			["7d", 84],
			["30d", 90],
		] as const) {
			const summary = await controller.summary({ organizationId }, range)
			const starts = summary.hosts[0]?.buckets.map((bucket) => Date.parse(bucket.start)) ?? []

			expect(starts).toHaveLength(count)
			expect((starts[1] ?? 0) - (starts[0] ?? 0)).toBe(summary.bucketSeconds * 1000)
		}
	})

	it("keeps a ten-minute outage to one slim bar in every range", async () => {
		for (const range of STATUS_RANGES) {
			const summary = await controller.summary({ organizationId }, range)
			const hit = summary.hosts[0]?.buckets.filter((bucket) => bucket.availability.badSeconds > 0)

			expect(hit?.map((bucket) => bucket.availability.badSeconds)).toEqual([600])
		}
	})

	it("works its percentage out over exactly the stretch the bars cover", async () => {
		for (const range of STATUS_RANGES) {
			const host = (await controller.summary({ organizationId }, range)).hosts[0]
			const summed = host?.buckets.reduce(
				(total, bucket) => ({
					good: total.good + bucket.availability.goodSeconds,
					bad: total.bad + bucket.availability.badSeconds,
				}),
				{ good: 0, bad: 0 },
			)

			expect(summed).toEqual({
				good: host?.availability.goodSeconds,
				bad: host?.availability.badSeconds,
			})
		}
	})
})
