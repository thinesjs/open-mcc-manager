import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { seedMember, seedOrganization, teardownTestDb, testDb } from "../test/db"
import type { ConnectionChange } from "./connection"
import { createStatusController, createStatusControllerTransaction } from "./status.controller"

const controller = createStatusController({
	withTransaction: createStatusControllerTransaction(testDb()),
	sendJob: async () => "job",
	hostNames: async () => [],
	instanceNames: async () => [],
	retentionDays: 30,
	now: () => new Date("2026-09-07T12:05:00Z"),
})

const suffix = (): string => Math.random().toString(36).slice(2, 10)

let organizationId = ""
let instanceId = ""

const lostAt = new Date("2026-09-07T12:00:00Z")
const backAt = new Date("2026-09-07T12:01:00Z")

const loss: ConnectionChange = {
	state: "interrupted",
	at: lostAt,
	pid: "1",
	event: "instance.connection_lost",
	reason: "lost",
}

const rejoin: ConnectionChange = {
	state: "joined",
	at: backAt,
	pid: "1",
	event: "instance.reconnected",
	reason: undefined,
}

const eventsFor = async () =>
	await testDb()
		.selectFrom("statusEvent")
		.select(["kind", "incidentId"])
		.where("organizationId", "=", organizationId)
		.where("instanceId", "=", instanceId)
		.orderBy("occurredAt", "asc")
		.execute()

beforeAll(async () => {
	organizationId = await seedOrganization("recovery-incident")
	await seedMember(organizationId)

	const hostId = `host-${suffix()}`
	await testDb()
		.insertInto("host")
		.values({ id: hostId, organizationId, name: hostId, hostname: "10.0.0.1" })
		.execute()

	instanceId = `inst-${suffix()}`
	await testDb()
		.insertInto("instance")
		.values({
			id: instanceId,
			organizationId,
			hostId,
			name: instanceId,
			minecraftAccount: "a@b.com",
			minecraftUsername: null,
			liveControlPort: 41000 + Math.floor(Math.random() * 2000),
		})
		.execute()
})

afterAll(async () => {
	await teardownTestDb()
})

describe("a recovery, taken through the real controller and database", () => {
	it("records the loss against a new incident", async () => {
		await controller.recordInstanceConnection(
			{ organizationId },
			{ id: instanceId, name: "LiveBot" },
			[loss],
		)

		const events = await eventsFor()
		expect(events).toHaveLength(1)
		expect(events[0]?.kind).toBe("instance.connection_lost")
		expect(events[0]?.incidentId).not.toBeNull()
	})

	it("records the rejoin against THE SAME incident, which is what the recovery lookup needs", async () => {
		await controller.recordInstanceConnection(
			{ organizationId },
			{ id: instanceId, name: "LiveBot" },
			[rejoin],
		)

		const events = await eventsFor()
		expect(events).toHaveLength(2)
		expect(events[1]?.kind).toBe("instance.reconnected")
		expect(events[1]?.incidentId).toBe(events[0]?.incidentId)
	})

	it("clears the incident from the condition once the bot is back", async () => {
		const condition = await testDb()
			.selectFrom("statusCondition")
			.select(["state", "activeIncidentId"])
			.where("organizationId", "=", organizationId)
			.where("instanceId", "=", instanceId)
			.where("dimension", "=", "instance.connection")
			.executeTakeFirstOrThrow()

		expect(condition.state).toBe("joined")
		expect(condition.activeIncidentId).toBeNull()
	})

	it("gives a later outage its own incident, so the two cannot be confused", async () => {
		await controller.recordInstanceConnection(
			{ organizationId },
			{ id: instanceId, name: "LiveBot" },
			[{ ...loss, at: new Date("2026-09-07T12:02:00Z") }],
		)

		const events = await eventsFor()
		expect(events).toHaveLength(3)
		expect(events[2]?.incidentId).not.toBe(events[0]?.incidentId)
		expect(events[2]?.incidentId).not.toBeNull()
	})
})
