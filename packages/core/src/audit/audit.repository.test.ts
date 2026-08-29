import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { seedOrganization, teardownTestDb, testDb, trackAuditEventId } from "../test/db"
import { createAuditRepository } from "./audit.repository"

const repo = createAuditRepository(testDb())
let orgA = ""
let orgB = ""

beforeAll(async () => {
	orgA = await seedOrganization("org-a")
	orgB = await seedOrganization("org-b")
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
				action: "host.create",
				subjectType: "host",
				subjectId: "n/a",
				detail: {},
			},
		)
		trackAuditEventId(created.id)
		const events = await repo.list({ organizationId: orgA })
		expect(events.some((event) => event.id === created.id)).toBe(true)
	})

	it("never lists another organization's audit events", async () => {
		const created = await repo.record(
			{ organizationId: orgA },
			{
				actorId: null,
				action: "host.delete",
				subjectType: "host",
				subjectId: "n/a",
				detail: {},
			},
		)
		trackAuditEventId(created.id)
		expect(await repo.list({ organizationId: orgB })).toEqual([])
	})
})
