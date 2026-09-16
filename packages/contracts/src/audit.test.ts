import { describe, expect, it } from "vitest"
import { AUDIT_PAGE_SIZE, auditEventViewSchema, auditListInput, auditPageSchema } from "./audit"

const VIEW = {
	id: "evt-1",
	actorLabel: "owner@example.com",
	action: "sshKey.create",
	subjectType: "sshKey",
	subjectId: "key-1",
	detail: { name: "deploy" },
	createdAt: "2026-09-06T00:00:00.000Z",
}

describe("when an audit event happened, as the wire sends it", () => {
	it("requires the ISO string a JSON response carries, not a Date object", () => {
		expect(auditEventViewSchema.safeParse({ ...VIEW, createdAt: new Date() }).success).toBe(false)
		expect(auditEventViewSchema.safeParse(VIEW).success).toBe(true)
	})

	it("keeps the recorded detail as plain strings", () => {
		expect(auditEventViewSchema.safeParse({ ...VIEW, detail: { count: 3 } }).success).toBe(false)
		expect(auditEventViewSchema.safeParse({ ...VIEW, detail: {} }).success).toBe(true)
	})
})

describe("what the reader asks for", () => {
	it("starts at the first page when no offset is given", () => {
		expect(auditListInput.parse({})).toEqual({ offset: 0 })
	})

	it("refuses to walk backwards past the start", () => {
		expect(auditListInput.safeParse({ offset: -1 }).success).toBe(false)
		expect(auditListInput.safeParse({ offset: 1.5 }).success).toBe(false)
		expect(auditListInput.safeParse({ offset: AUDIT_PAGE_SIZE }).success).toBe(true)
	})
})

describe("the page a reader gets back", () => {
	it("carries the whole count beside the rows it shows", () => {
		expect(auditPageSchema.parse({ items: [VIEW], total: 312 })).toEqual({
			items: [VIEW],
			total: 312,
		})
	})

	it("rejects a page with no total, which is the defect this view exists to remove", () => {
		expect(auditPageSchema.safeParse({ items: [VIEW] }).success).toBe(false)
	})
})
