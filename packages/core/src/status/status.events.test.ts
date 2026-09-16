import { randomUUID } from "node:crypto"
import { statusEventsInput } from "@open-mcc/contracts"
import { parseStatusEventCursor } from "@open-mcc/contracts/boundary/status-cursor"
import type { StatusEventInsert } from "@open-mcc/db"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { seedOrganization, teardownTestDb, testDb, trackHostId, trackInstanceId } from "../test/db"
import { createStatusController, createStatusControllerTransaction } from "./status.controller"
import { createStatusRepository } from "./status.repository"

const now = new Date("2026-09-13T10:07:30Z")
const since = new Date(now.getTime() - 24 * 60 * 60 * 1000)

const WATCHED_EVENTS = 25
const TIED_MINUTES = 3
const OUTSIDE_RANGE_MINUTES = 25 * 60

let organizationId = ""
let otherOrganizationId = ""
let watchedHostId = ""
let quietHostId = ""
let watchedInstanceId = ""
let quietInstanceId = ""
let otherInstanceId = ""

const repository = createStatusRepository(testDb())

const controller = createStatusController({
	withTransaction: createStatusControllerTransaction(testDb()),
	sendJob: async () => "job",
	hostNames: async () => [],
	instanceNames: async () => [],
	retentionDays: 30,
	now: () => now,
})

const minutesAgo = (minutes: number) => new Date(now.getTime() - minutes * 60 * 1000)

const RUN = randomUUID()

const idFor = (suffix: string) => `${RUN}-${suffix}`

const event = (
	suffix: string,
	occurredAt: Date,
	subject: { organizationId: string; hostId: string | null; instanceId: string | null },
): StatusEventInsert => ({
	id: idFor(suffix),
	organizationId: subject.organizationId,
	subjectType: subject.instanceId === null ? "host" : "instance",
	subjectId: subject.instanceId ?? subject.hostId ?? subject.organizationId,
	subjectLabel: subject.instanceId === null ? "watched" : "afk-one",
	hostId: subject.hostId,
	instanceId: subject.instanceId,
	kind: subject.instanceId === null ? "host.unreachable" : "instance.disconnected",
	occurredAt,
	observedAt: occurredAt,
	lastCorroboratedAt: occurredAt,
	incidentId: null,
	primarySource: subject.instanceId === null ? "host_probe" : "journal",
	sourceKey: null,
})

const watchedSuffix = (index: number) => `ev-${String(index).padStart(2, "0")}`

const watchedId = (index: number) => idFor(watchedSuffix(index))

const seedHost = async (scope: string, label: string) => {
	const id = `host-${randomUUID()}`
	await testDb()
		.insertInto("host")
		.values({ id, organizationId: scope, name: label, hostname: `${label}.example` })
		.execute()
	trackHostId(id)
	return id
}

const seedInstance = async (scope: string, hostId: string, port: number) => {
	const id = `inst-${randomUUID()}`
	await testDb()
		.insertInto("instance")
		.values({
			id,
			organizationId: scope,
			hostId,
			name: `afk-${port}`,
			minecraftAccount: "a@b.com",
			minecraftUsername: null,
			liveControlPort: port,
		})
		.execute()
	trackInstanceId(id)
	return id
}

const expectedOrder = () => {
	const ids = Array.from({ length: WATCHED_EVENTS }, (_, index) => watchedId(index))
	const tied = ids.slice(TIED_MINUTES, TIED_MINUTES + 2)
	return [...ids.slice(0, TIED_MINUTES), ...[...tied].reverse(), ...ids.slice(TIED_MINUTES + 2)]
}

beforeAll(async () => {
	organizationId = await seedOrganization("status-events")
	otherOrganizationId = await seedOrganization("status-events-other")
	watchedHostId = await seedHost(organizationId, "watched")
	quietHostId = await seedHost(organizationId, "quiet")
	const otherHostId = await seedHost(otherOrganizationId, "stranger")
	watchedInstanceId = await seedInstance(organizationId, watchedHostId, 31001)
	quietInstanceId = await seedInstance(organizationId, quietHostId, 31002)
	otherInstanceId = await seedInstance(otherOrganizationId, otherHostId, 31003)

	const watched = Array.from({ length: WATCHED_EVENTS }, (_, index) =>
		event(watchedSuffix(index), minutesAgo(index === TIED_MINUTES + 1 ? TIED_MINUTES : index), {
			organizationId,
			hostId: null,
			instanceId: watchedInstanceId,
		}),
	)

	await testDb()
		.insertInto("statusEvent")
		.values([
			...watched,
			event("ev-host-a", minutesAgo(40), {
				organizationId,
				hostId: watchedHostId,
				instanceId: null,
			}),
			event("ev-host-b", minutesAgo(41), {
				organizationId,
				hostId: watchedHostId,
				instanceId: null,
			}),
			event("ev-host-quiet", minutesAgo(42), {
				organizationId,
				hostId: quietHostId,
				instanceId: null,
			}),
			event("ev-inst-quiet", minutesAgo(43), {
				organizationId,
				hostId: null,
				instanceId: quietInstanceId,
			}),
			event("ev-stale-instance", minutesAgo(OUTSIDE_RANGE_MINUTES), {
				organizationId,
				hostId: null,
				instanceId: watchedInstanceId,
			}),
			event("ev-stale-host", minutesAgo(OUTSIDE_RANGE_MINUTES), {
				organizationId,
				hostId: watchedHostId,
				instanceId: null,
			}),
			event("ev-stranger-a", minutesAgo(1), {
				organizationId: otherOrganizationId,
				hostId: null,
				instanceId: otherInstanceId,
			}),
			event("ev-stranger-b", minutesAgo(2), {
				organizationId: otherOrganizationId,
				hostId: null,
				instanceId: otherInstanceId,
			}),
		])
		.execute()
})

afterAll(async () => {
	await teardownTestDb()
})

const page = async (limit: number, cursor?: { occurredAt: Date; id: string }) =>
	await repository.listEvents(
		{ organizationId },
		{
			since,
			limit,
			instanceId: watchedInstanceId,
			...(cursor === undefined ? {} : { cursor }),
		},
	)

const cursorOf = (rows: { occurredAt: Date; id: string }[]) => {
	const last = rows[rows.length - 1]
	if (last === undefined) throw new Error("expected a row to take a cursor from")
	return { occurredAt: last.occurredAt, id: last.id }
}

describe("paging the status events through the real database", () => {
	it("hands out two pages that neither overlap nor leave a gap", async () => {
		const first = await page(8)
		const second = await page(8, cursorOf(first))

		expect(first.map((row) => row.id)).toEqual(expectedOrder().slice(0, 8))
		expect(second.map((row) => row.id)).toEqual(expectedOrder().slice(8, 16))
		expect(first.map((row) => row.id).filter((id) => second.some((row) => row.id === id))).toEqual(
			[],
		)
	})

	it("resumes after a row whose timestamp another row shares", async () => {
		const first = await page(TIED_MINUTES + 1)
		const second = await page(1, cursorOf(first))
		const tied = expectedOrder().slice(TIED_MINUTES, TIED_MINUTES + 2)

		expect(first[first.length - 1]?.id).toBe(tied[0])
		expect(second.map((row) => row.id)).toEqual([tied[1]])
		expect(second[0]?.occurredAt.getTime()).toBe(first[first.length - 1]?.occurredAt.getTime())
	})

	it("walks the whole set in pages without losing or repeating a row", async () => {
		const seen: string[] = []
		let cursor: { occurredAt: Date; id: string } | undefined
		for (let round = 0; round < WATCHED_EVENTS; round += 1) {
			const rows = await page(4, cursor)
			if (rows.length === 0) break
			seen.push(...rows.map((row) => row.id))
			cursor = cursorOf(rows)
		}

		expect(seen).toEqual(expectedOrder())
	})

	it("counts the whole filtered set rather than the page", async () => {
		const first = await page(8)
		const total = await repository.countEvents(
			{ organizationId },
			{ since, instanceId: watchedInstanceId },
		)

		expect(first).toHaveLength(8)
		expect(total).toBe(WATCHED_EVENTS)
	})

	it("counts and lists the same set once a host filter narrows it", async () => {
		const rows = await repository.listEvents(
			{ organizationId },
			{ since, limit: 100, hostId: watchedHostId },
		)
		const total = await repository.countEvents({ organizationId }, { since, hostId: watchedHostId })

		expect(rows.map((row) => row.id)).toEqual([idFor("ev-host-a"), idFor("ev-host-b")])
		expect(total).toBe(2)
	})

	it("leaves an event older than the range out of both the page and the total", async () => {
		const rows = await repository.listEvents(
			{ organizationId },
			{ since, limit: 100, instanceId: watchedInstanceId },
		)
		const total = await repository.countEvents(
			{ organizationId },
			{ since, instanceId: watchedInstanceId },
		)
		const forHost = await repository.listEvents(
			{ organizationId },
			{ since, limit: 100, hostId: watchedHostId },
		)
		const hostTotal = await repository.countEvents(
			{ organizationId },
			{ since, hostId: watchedHostId },
		)

		expect(rows.map((row) => row.id)).not.toContain(idFor("ev-stale-instance"))
		expect(total).toBe(WATCHED_EVENTS)
		expect(forHost.map((row) => row.id)).not.toContain(idFor("ev-stale-host"))
		expect(hostTotal).toBe(2)
	})

	it("shows another organization's events in neither the page nor the count", async () => {
		const rows = await repository.listEvents({ organizationId }, { since, limit: 100 })
		const total = await repository.countEvents({ organizationId }, { since })
		const strangers = await repository.countEvents(
			{ organizationId: otherOrganizationId },
			{ since },
		)

		expect(rows.map((row) => row.id)).not.toContain(idFor("ev-stranger-a"))
		expect(rows.map((row) => row.id)).not.toContain(idFor("ev-stranger-b"))
		expect(total).toBe(WATCHED_EVENTS + 4)
		expect(strangers).toBe(2)
	})
})

describe("the events the controller hands the dashboard", () => {
	it("reports the total for the filtered set, not the page it returned", async () => {
		const first = await controller.events({ organizationId }, "24h", 8, {
			instanceId: watchedInstanceId,
		})

		expect(first.events).toHaveLength(8)
		expect(first.total).toBe(WATCHED_EVENTS)
		expect(first.nextCursor).not.toBeNull()
	})

	it("keeps the total on the filter when a cursor moves it to a later page", async () => {
		const first = await controller.events({ organizationId }, "24h", 8, {
			instanceId: watchedInstanceId,
		})
		const marker = parseStatusEventCursor(first.nextCursor ?? "")
		if (marker === undefined) throw new Error("expected a cursor from the first page")
		const second = await controller.events({ organizationId }, "24h", 8, {
			instanceId: watchedInstanceId,
			cursor: marker,
		})

		expect(second.total).toBe(WATCHED_EVENTS)
		expect(second.events.map((each) => each.id)).toEqual(expectedOrder().slice(8, 16))
	})

	it("narrows the total with the filter rather than reporting every event", async () => {
		const forHost = await controller.events({ organizationId }, "24h", 8, {
			hostId: watchedHostId,
		})

		expect(forHost.total).toBe(2)
		expect(forHost.events).toHaveLength(2)
		expect(forHost.nextCursor).toBeNull()
	})

	it("keeps an event older than the range out of the total the card shows", async () => {
		const shown = await controller.events({ organizationId }, "24h", 100, {
			instanceId: watchedInstanceId,
		})

		expect(shown.total).toBe(WATCHED_EVENTS)
		expect(shown.events.map((each) => each.id)).not.toContain(idFor("ev-stale-instance"))
	})

	it("stops offering a cursor once the last page is short", async () => {
		const last = await controller.events({ organizationId }, "24h", 100, {
			instanceId: watchedInstanceId,
		})

		expect(last.events).toHaveLength(WATCHED_EVENTS)
		expect(last.nextCursor).toBeNull()
	})
})

describe("the cursor the boundary accepts", () => {
	it("refuses a cursor that is not one this list handed out", () => {
		const result = statusEventsInput.safeParse({ cursor: "not-a-cursor", limit: 8 })

		expect(result.success).toBe(false)
		expect(result.error?.issues[0]?.message).toBe(
			"That page marker is not one this list handed out.",
		)
	})

	it("accepts a cursor the controller handed out and reads both halves back", async () => {
		const first = await controller.events({ organizationId }, "24h", 8, {
			instanceId: watchedInstanceId,
		})
		const result = statusEventsInput.safeParse({ cursor: first.nextCursor, limit: 8 })
		const eighth = first.events[7]

		expect(result.success).toBe(true)
		expect(result.data?.cursor?.id).toBe(eighth?.id)
		expect(result.data?.cursor?.occurredAt.getTime()).toBe(eighth?.occurredAt.getTime())
	})
})
