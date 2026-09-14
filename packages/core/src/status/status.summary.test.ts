import { randomUUID } from "node:crypto"
import { RANGE_SECONDS, STATUS_RANGES } from "@open-mcc/contracts"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { seedOrganization, teardownTestDb, testDb, trackHostId } from "../test/db"
import { createStatusController, createStatusControllerTransaction } from "./status.controller"

const now = new Date("2026-09-13T10:07:30Z")
const hostId = `host-${randomUUID()}`
const edgeHostId = `host-${randomUUID()}`
let organizationId = ""

const controller = createStatusController({
	withTransaction: createStatusControllerTransaction(testDb()),
	sendJob: async () => "job",
	hostNames: async () => [
		{ id: hostId, name: "survival" },
		{ id: edgeHostId, name: "edge" },
	],
	instanceNames: async () => [],
	retentionDays: 30,
	now: () => now,
})

const interval = (
	host: string,
	state: "up" | "down",
	startedAt: string,
	endedAt: string | null,
) => ({
	id: randomUUID(),
	organizationId,
	hostId: host,
	instanceId: null,
	dimension: "host.reachability" as const,
	state,
	startedAt: new Date(startedAt),
	endedAt: endedAt === null ? null : new Date(endedAt),
	startEventId: null,
	endEventId: null,
})

const summaryFor = async (range: (typeof STATUS_RANGES)[number], host: string) =>
	(await controller.summary({ organizationId }, range)).hosts.find((each) => each.hostId === host)

beforeAll(async () => {
	organizationId = await seedOrganization("status-summary")
	await testDb()
		.insertInto("host")
		.values([
			{ id: hostId, organizationId, name: hostId, hostname: "survival.example" },
			{ id: edgeHostId, organizationId, name: edgeHostId, hostname: "edge.example" },
		])
		.execute()
	trackHostId(hostId)
	trackHostId(edgeHostId)
	await testDb()
		.insertInto("statusInterval")
		.values([
			interval(hostId, "up", "2026-08-01T00:00:00Z", "2026-09-13T08:00:00Z"),
			interval(hostId, "down", "2026-09-13T08:00:00Z", "2026-09-13T08:10:00Z"),
			interval(hostId, "up", "2026-09-13T08:10:00Z", null),
			interval(edgeHostId, "up", "2026-08-01T00:00:00Z", "2026-08-14T10:07:30Z"),
			interval(edgeHostId, "down", "2026-08-14T10:07:30Z", "2026-08-14T10:12:30Z"),
			interval(edgeHostId, "up", "2026-08-14T10:12:30Z", "2026-09-06T10:07:30Z"),
			interval(edgeHostId, "down", "2026-09-06T10:07:30Z", "2026-09-06T10:12:30Z"),
			interval(edgeHostId, "up", "2026-09-06T10:12:30Z", "2026-09-12T10:07:30Z"),
			interval(edgeHostId, "down", "2026-09-12T10:07:30Z", "2026-09-12T10:12:30Z"),
			interval(edgeHostId, "up", "2026-09-12T10:12:30Z", null),
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
			const starts =
				summary.hosts
					.find((each) => each.hostId === hostId)
					?.buckets.map((bucket) => Date.parse(bucket.start)) ?? []

			expect(starts).toHaveLength(count)
			expect(starts[0]).toBe(now.getTime() - RANGE_SECONDS[range] * 1000)
			expect((starts[2] ?? 0) - (starts[1] ?? 0)).toBe(summary.bucketSeconds * 1000)
		}
	})

	it("keeps a ten-minute outage to one slim bar in every range", async () => {
		for (const range of STATUS_RANGES) {
			const hit = (await summaryFor(range, hostId))?.buckets.filter(
				(bucket) => bucket.availability.badSeconds > 0,
			)

			expect(hit?.map((bucket) => bucket.availability.badSeconds)).toEqual([600])
		}
	})

	it("works its percentage out over exactly the stretch the bars cover", async () => {
		for (const range of STATUS_RANGES) {
			for (const host of [hostId, edgeHostId]) {
				const summary = await summaryFor(range, host)
				const summed = summary?.buckets.reduce(
					(total, bucket) => ({
						good: total.good + bucket.availability.goodSeconds,
						bad: total.bad + bucket.availability.badSeconds,
					}),
					{ good: 0, bad: 0 },
				)

				expect(summed).toEqual({
					good: summary?.availability.goodSeconds,
					bad: summary?.availability.badSeconds,
				})
			}
		}
	})

	it("★ counts an outage in the first minutes of the range, in the bars and in the percentage", async () => {
		for (const [range, bad] of [
			["24h", 300],
			["7d", 600],
			["30d", 900],
		] as const) {
			const summary = await summaryFor(range, edgeHostId)
			const barred = summary?.buckets.reduce(
				(total, bucket) => total + bucket.availability.badSeconds,
				0,
			)

			expect({ range, bars: barred, percentage: summary?.availability.badSeconds }).toEqual({
				range,
				bars: bad,
				percentage: bad,
			})
		}
	})
})
