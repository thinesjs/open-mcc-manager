import type { AuditEventView } from "@open-mcc/contracts"
import { describe, expect, it } from "vitest"
import { auditSubject, describeAuditAction, describeAuditEvent } from "./audit-events"

const event = (overrides: Partial<AuditEventView> = {}): AuditEventView => ({
	id: "evt-1",
	actorLabel: "owner@example.com",
	action: "sshKey.create",
	subjectType: "sshKey",
	subjectId: "key-1",
	detail: { name: "deploy" },
	createdAt: "2026-09-06T12:00:00.000Z",
	...overrides,
})

describe("how a recorded action reads", () => {
	it("says who did what to which thing, not a raw action string", () => {
		expect(describeAuditEvent(event())).toBe("owner@example.com generated the SSH key deploy.")
	})

	it("names the actor the trail kept, including system work", () => {
		expect(
			describeAuditEvent(
				event({
					actorLabel: "system",
					action: "host.provision.reclaim",
					detail: { hostname: "box.example.com" },
				}),
			),
		).toBe("system took over a stalled setup of the host box.example.com.")
	})

	it("still says something honest for an action nobody has written copy for", () => {
		const sentence = describeAuditEvent(
			event({ action: "host.teleport", detail: {}, subjectId: "host-9" }),
		)
		expect(sentence).toBe("owner@example.com host teleport host-9.")
		expect(sentence).not.toContain("undefined")
	})

	it("leaves the verb alone when the action is unmapped, rather than inventing one", () => {
		expect(describeAuditAction("something.brand.new", "thing")).toBe("something brand new thing.")
	})
})

describe("which name a row shows for its subject", () => {
	it("prefers the name the trail recorded over the opaque id", () => {
		expect(auditSubject({ subjectId: "dst-1", detail: { name: "Ops channel" } })).toBe(
			"Ops channel",
		)
		expect(auditSubject({ subjectId: "host-1", detail: { hostname: "box" } })).toBe("box")
		expect(auditSubject({ subjectId: "mem-1", detail: { email: "a@b.c" } })).toBe("a@b.c")
	})

	it("falls back to the id when the trail recorded no name", () => {
		expect(auditSubject({ subjectId: "inst-1", detail: {} })).toBe("inst-1")
		expect(auditSubject({ subjectId: "inst-1", detail: { name: "   " } })).toBe("inst-1")
	})
})
