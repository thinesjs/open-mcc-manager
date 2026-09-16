import type { AuditAction, AuditEventView } from "@open-mcc/contracts"
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

describe("the actions this page exists to make readable", () => {
	it("says who was invited and who joined, in words", () => {
		expect(
			describeAuditEvent(
				event({
					action: "member.invite",
					subjectType: "invitation",
					subjectId: "inv-1",
					detail: { email: "bob@example.com", role: "operator" },
				}),
			),
		).toBe("owner@example.com invited bob@example.com.")
		expect(
			describeAuditEvent(
				event({
					actorLabel: "bob@example.com",
					action: "member.accept",
					subjectType: "member",
					subjectId: "mem-abc123",
					detail: { invitationId: "inv-1", role: "operator" },
				}),
			),
		).toBe("bob@example.com joined the organization.")
	})

	it("says which way an alert destination was toggled, not which enum the branch picked", () => {
		const toggled = (action: AuditAction): string =>
			describeAuditEvent(
				event({
					action,
					subjectType: "notificationDestination",
					subjectId: "dst-1",
					detail: { name: "Ops channel" },
				}),
			)

		expect(toggled("notification.destination.enable")).toBe(
			"owner@example.com turned on the alert destination Ops channel.",
		)
		expect(toggled("notification.destination.disable")).toBe(
			"owner@example.com turned off the alert destination Ops channel.",
		)
	})

	it("never prints an opaque id where the trail recorded no name to print", () => {
		expect(
			describeAuditEvent(
				event({
					actorLabel: "bob@example.com",
					action: "member.accept",
					subjectId: "mem-abc123",
					detail: {},
				}),
			),
		).not.toContain("mem-abc123")
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
