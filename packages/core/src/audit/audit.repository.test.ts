import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { seedMember, seedOrganization, teardownTestDb, testDb, trackAuditEventId } from "../test/db"
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
				actorLabel: "",
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
				actorLabel: "",
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
