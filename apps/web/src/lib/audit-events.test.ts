import { readdirSync, readFileSync, statSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import type { AuditEventView } from "@open-mcc/contracts"
import { describe, expect, it } from "vitest"
import {
	auditSubject,
	describeAuditAction,
	describeAuditEvent,
	hasAuditTemplate,
} from "./audit-events"

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..")

const RECORDING_ROOTS = [
	join("packages", "core", "src"),
	join("apps", "server", "src"),
	join("apps", "worker", "src"),
]

const AUDIT_ENTRY = /actorLabel:[\s\S]{0,200}?action: "([^"]+)"/g

const sourceFilesUnder = (dir: string, found: string[] = []): string[] => {
	for (const entry of readdirSync(dir).sort()) {
		const full = join(dir, entry)
		if (statSync(full).isDirectory()) {
			sourceFilesUnder(full, found)
			continue
		}
		if (entry.endsWith(".ts") && !entry.includes(".test.")) found.push(full)
	}
	return found
}

const recordedActions = (): string[] => {
	const actions = new Set<string>()
	for (const root of RECORDING_ROOTS) {
		for (const file of sourceFilesUnder(join(repoRoot, root))) {
			for (const match of readFileSync(file, "utf8").matchAll(AUDIT_ENTRY)) {
				const action = match[1]
				if (action !== undefined) actions.add(action)
			}
		}
	}
	return [...actions].sort()
}

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

describe("every action this codebase records", () => {
	it("has copy, so nothing reaches the page as raw enum text", () => {
		const recorded = recordedActions()

		expect(recorded.length).toBeGreaterThan(25)
		expect(recorded.filter((action) => !hasAuditTemplate(action))).toEqual([])
	})

	it("includes the member lifecycle, which is why this page is owner-only", () => {
		const recorded = recordedActions()

		expect(recorded).toContain("member.invite")
		expect(recorded).toContain("member.accept")
		expect(recorded).toContain("host.teardown")
	})

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
