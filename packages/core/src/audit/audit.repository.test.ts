import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { seedMember, seedOrganization, teardownTestDb, testDb, trackAuditEventId } from "../test/db"
import { createAuditRepository } from "./audit.repository"

const repo = createAuditRepository(testDb())
const WHOLE_PAGE = { limit: 100, offset: 0 }
const TIED_AT = new Date("2026-09-06T12:00:02.000Z")

const PAGED: ReadonlyArray<{ id: string; at: Date }> = [
	{ id: "audit-paging-a", at: new Date("2026-09-06T12:00:04.000Z") },
	{ id: "audit-paging-b", at: new Date("2026-09-06T12:00:03.000Z") },
	{ id: "audit-paging-c", at: TIED_AT },
	{ id: "audit-paging-d", at: TIED_AT },
	{ id: "audit-paging-e", at: new Date("2026-09-06T12:00:01.000Z") },
]

const OTHER_ORG_EVENT_ID = "audit-paging-other"

let orgA = ""
let orgB = ""
let orgPaged = ""
let orgOther = ""

const seedEventAt = async (organizationId: string, id: string, createdAt: Date): Promise<void> => {
	await testDb()
		.insertInto("auditEvent")
		.values({
			id,
			organizationId,
			actorId: null,
			actorLabel: "system",
			action: "host.enroll",
			subjectType: "host",
			subjectId: id,
			createdAt,
		})
		.execute()
	trackAuditEventId(id)
}

beforeAll(async () => {
	orgA = await seedOrganization("org-a")
	orgB = await seedOrganization("org-b")
	orgPaged = await seedOrganization("org-paged")
	orgOther = await seedOrganization("org-other")
	for (const event of PAGED) {
		await seedEventAt(orgPaged, event.id, event.at)
	}
	await seedEventAt(orgOther, OTHER_ORG_EVENT_ID, TIED_AT)
})

afterAll(async () => {
	await teardownTestDb()
})

describe("audit repository organization scoping", () => {
	it("records an event scoped to its organization and lists it back", async () => {
		const created = await repo.record(
			{ organizationId: orgA },
			{
				actorId: null,
				actorLabel: "",
				action: "host.enroll",
				subjectType: "host",
				subjectId: "n/a",
				detail: {},
			},
		)
		trackAuditEventId(created.id)
		const events = await repo.list({ organizationId: orgA }, WHOLE_PAGE)
		expect(events.some((event) => event.id === created.id)).toBe(true)
	})

	it("never lists another organization's audit events", async () => {
		const created = await repo.record(
			{ organizationId: orgA },
			{
				actorId: null,
				actorLabel: "",
				action: "host.delete",
				subjectType: "host",
				subjectId: "n/a",
				detail: {},
			},
		)
		trackAuditEventId(created.id)
		expect(await repo.list({ organizationId: orgB }, WHOLE_PAGE)).toEqual([])
	})
})

describe("audit repository actor attribution label", () => {
	it("records the caller-supplied label, not the member id, as immutable attribution", async () => {
		const memberId = await seedMember(orgA)
		const created = await repo.record(
			{ organizationId: orgA },
			{
				actorId: memberId,
				actorLabel: "actor@example.com",
				action: "host.enroll",
				subjectType: "host",
				subjectId: "n/a",
				detail: {},
			},
		)
		trackAuditEventId(created.id)
		expect(created.actorLabel).toBe("actor@example.com")
		expect(created.actorLabel).not.toBe(memberId)
	})

	it("falls back to a placeholder label when the event has no actor", async () => {
		const created = await repo.record(
			{ organizationId: orgA },
			{
				actorId: null,
				actorLabel: "",
				action: "host.enroll",
				subjectType: "host",
				subjectId: "n/a",
				detail: {},
			},
		)
		trackAuditEventId(created.id)
		expect(created.actorLabel).toBe("system")
	})

	it("rejects a real actor with an empty label rather than writing a silent placeholder", async () => {
		const memberId = await seedMember(orgA)
		await expect(
			repo.record(
				{ organizationId: orgA },
				{
					actorId: memberId,
					actorLabel: "",
					action: "host.enroll",
					subjectType: "host",
					subjectId: "n/a",
					detail: {},
				},
			),
		).rejects.toThrow(/actorLabel is required/i)
	})

	it("rejects a real actor with a whitespace-only label", async () => {
		const memberId = await seedMember(orgA)
		await expect(
			repo.record(
				{ organizationId: orgA },
				{
					actorId: memberId,
					actorLabel: "   ",
					action: "host.enroll",
					subjectType: "host",
					subjectId: "n/a",
					detail: {},
				},
			),
		).rejects.toThrow(/actorLabel is required/i)
	})
})

describe("audit repository paging", () => {
	const idsOf = async (offset: number): Promise<string[]> =>
		(await repo.list({ organizationId: orgPaged }, { limit: 2, offset })).map((row) => row.id)

	it("orders newest first and breaks a shared timestamp by id, so a tie cannot shuffle", async () => {
		const ordered = await repo.list({ organizationId: orgPaged }, { limit: 10, offset: 0 })
		expect(ordered.map((row) => row.id)).toEqual([
			"audit-paging-a",
			"audit-paging-b",
			"audit-paging-d",
			"audit-paging-c",
			"audit-paging-e",
		])
	})

	it("walks the whole set with no overlap and no gap", async () => {
		const first = await idsOf(0)
		const second = await idsOf(2)
		const third = await idsOf(4)

		expect(first).toEqual(["audit-paging-a", "audit-paging-b"])
		expect(second).toEqual(["audit-paging-d", "audit-paging-c"])
		expect(third).toEqual(["audit-paging-e"])

		const walked = [...first, ...second, ...third]
		expect(new Set(walked).size).toBe(walked.length)
		expect([...walked].sort()).toEqual(PAGED.map((event) => event.id).sort())
	})

	it("counts the whole set rather than the page in hand", async () => {
		expect(await repo.count({ organizationId: orgPaged })).toBe(PAGED.length)
		expect((await idsOf(0)).length).toBe(2)
	})

	it("never lets another organization's events into the page or the count", async () => {
		const walked = [...(await idsOf(0)), ...(await idsOf(2)), ...(await idsOf(4))]
		expect(walked).not.toContain(OTHER_ORG_EVENT_ID)
		expect(await repo.count({ organizationId: orgOther })).toBe(1)
	})
})
