import type { Role } from "@open-mcc/contracts"
import { describe, expect, it, vi } from "vitest"
import type { AuditEntry } from "../audit/audit.repository"
import { type ActorContext, ForbiddenError } from "../host/host.controller"
import {
	createMemberController,
	LastOwnerError,
	type MemberControllerDeps,
	type MemberTransactionRepos,
} from "./member.controller"
import type { MemberRepository } from "./member.repository"

type MemberRow = NonNullable<Awaited<ReturnType<MemberRepository["findById"]>>>
type InvitationRow = Awaited<ReturnType<MemberRepository["listPendingInvitations"]>>[number]

const actor = (role: Role): ActorContext => ({
	organizationId: "org-1",
	memberId: "mem-owner",
	actorLabel: "owner@example.com",
	role,
})

const memberRow = (overrides: Partial<MemberRow> = {}): MemberRow => ({
	id: "mem-target",
	userId: "user-target",
	role: "operator",
	name: "Target",
	email: "target@example.com",
	createdAt: new Date("2026-09-01T00:00:00.000Z"),
	...overrides,
})

const callerRow = (overrides: Partial<MemberRow> = {}): MemberRow =>
	memberRow({
		id: "mem-owner",
		userId: "user-owner",
		role: "owner",
		name: "Owner",
		email: "owner@example.com",
		...overrides,
	})

const invitationRow = (overrides: Partial<InvitationRow> = {}): InvitationRow => ({
	id: "inv-1",
	email: "new@example.com",
	role: "viewer",
	expiresAt: new Date("2026-09-20T00:00:00.000Z"),
	...overrides,
})

type Options = {
	target?: MemberRow | null
	caller?: MemberRow | null
	owners?: number
	cancelled?: boolean
	revokeFails?: boolean
	members?: MemberRow[]
	invitations?: InvitationRow[]
}

const harness = (options: Options = {}) => {
	const events: string[] = []
	const audited: AuditEntry[] = []
	const target = options.target === undefined ? memberRow() : options.target
	const caller = options.caller === undefined ? callerRow() : options.caller
	const repos: MemberTransactionRepos = {
		members: {
			lock: vi.fn(async () => {
				events.push("lock")
			}),
			findById: vi.fn(async (_scope, id: string) => {
				if (id === "mem-owner") {
					events.push("find-caller")
					return caller ?? undefined
				}
				events.push("find")
				return target ?? undefined
			}),
			countOwners: vi.fn(async () => {
				events.push("count")
				return options.owners ?? 2
			}),
			delete: vi.fn(async () => {
				events.push("delete")
				return true
			}),
			cancelInvitation: vi.fn(async () => {
				events.push("cancel")
				return options.cancelled ?? true
			}),
			cancelInvitationsSentBy: vi.fn(async () => {
				events.push("cancel-sent")
				return 2
			}),
		},
		audit: {
			record: vi.fn(async (_scope, entry: AuditEntry) => {
				events.push(`audit:${entry.action}`)
				audited.push(entry)
				return {
					id: "audit-1",
					organizationId: "org-1",
					actorId: entry.actorId,
					actorLabel: entry.actorLabel,
					action: entry.action,
					subjectType: entry.subjectType,
					subjectId: entry.subjectId,
					detail: entry.detail,
					createdAt: new Date("2026-09-01T00:00:00.000Z"),
				}
			}),
		},
	}
	const deps: MemberControllerDeps = {
		members: {
			list: vi.fn(async () => options.members ?? []),
			listPendingInvitations: vi.fn(async () => options.invitations ?? []),
		},
		withTransaction: async (fn) => {
			events.push("begin")
			const result = await fn(repos)
			events.push("commit")
			return result
		},
		revokeSessions: vi.fn(async (_scope, userId: string) => {
			events.push(`revoke:${userId}`)
			if (options.revokeFails) throw new Error("connection lost")
		}),
		reportError: vi.fn(() => {
			events.push("report")
		}),
	}
	return { deps, events, audited }
}

describe("removing a member", () => {
	it("deletes them under the lock, audits it, and signs them out only once that commits", async () => {
		const { deps, events, audited } = harness()

		await expect(createMemberController(deps).remove(actor("owner"), "mem-target")).resolves.toBe(
			true,
		)

		expect(events).toEqual([
			"begin",
			"lock",
			"find-caller",
			"find",
			"delete",
			"cancel-sent",
			"audit:member.remove",
			"commit",
			"revoke:user-target",
		])
		expect(audited[0]).toEqual({
			actorId: "mem-owner",
			actorLabel: "owner@example.com",
			action: "member.remove",
			subjectType: "member",
			subjectId: "mem-target",
			detail: { email: "target@example.com", role: "operator", invitationsCancelled: "2" },
		})
		expect(deps.reportError).not.toHaveBeenCalled()
	})

	it.each(["operator", "viewer"] as const)(
		"refuses a %s, touching nothing and signing no one out",
		async (role) => {
			const { deps, events } = harness()

			await expect(
				createMemberController(deps).remove(actor(role), "mem-target"),
			).rejects.toBeInstanceOf(ForbiddenError)

			expect(events).toEqual([])
		},
	)

	it("refuses an owner removing themselves", async () => {
		const { deps, events } = harness({ target: memberRow({ id: "mem-owner", role: "owner" }) })

		await expect(
			createMemberController(deps).remove(actor("owner"), "mem-owner"),
		).rejects.toBeInstanceOf(ForbiddenError)

		expect(events).toEqual([])
	})

	it("refuses an owner who was removed while their request waited for the lock", async () => {
		const { deps, events } = harness({ caller: null })

		await expect(
			createMemberController(deps).remove(actor("owner"), "mem-target"),
		).rejects.toBeInstanceOf(ForbiddenError)

		expect(events).toEqual(["begin", "lock", "find-caller"])
	})

	it("refuses a caller who is no longer an owner by the time the lock is held", async () => {
		const { deps, events } = harness({ caller: callerRow({ role: "operator" }) })

		await expect(
			createMemberController(deps).remove(actor("owner"), "mem-target"),
		).rejects.toBeInstanceOf(ForbiddenError)

		expect(events).toEqual(["begin", "lock", "find-caller"])
	})

	it("refuses to remove the last owner, counting under the lock", async () => {
		const { deps, events } = harness({ target: memberRow({ role: "owner" }), owners: 1 })

		await expect(
			createMemberController(deps).remove(actor("owner"), "mem-target"),
		).rejects.toBeInstanceOf(LastOwnerError)

		expect(events).toEqual(["begin", "lock", "find-caller", "find", "count"])
	})

	it("removes an owner while another owner remains", async () => {
		const { deps, events } = harness({ target: memberRow({ role: "owner" }), owners: 2 })

		await expect(createMemberController(deps).remove(actor("owner"), "mem-target")).resolves.toBe(
			true,
		)

		expect(events).toContain("delete")
		expect(events.at(-1)).toBe("revoke:user-target")
	})

	it("reports nothing removed for a member this organization does not have", async () => {
		const { deps, events } = harness({ target: null })

		await expect(
			createMemberController(deps).remove(actor("owner"), "mem-elsewhere"),
		).resolves.toBe(false)

		expect(events).toEqual(["begin", "lock", "find-caller", "find", "commit"])
	})

	it("signs no one out when the removal does not commit", async () => {
		const { deps, events } = harness()
		const failing: MemberControllerDeps = {
			...deps,
			withTransaction: async () => {
				throw new Error("connection lost")
			},
		}

		await expect(
			createMemberController(failing).remove(actor("owner"), "mem-target"),
		).rejects.toThrow("connection lost")

		expect(events.filter((event) => event.startsWith("revoke"))).toEqual([])
	})

	it("still reports the removal as done when signing the member out fails afterwards, and reports that failure", async () => {
		const { deps, events } = harness({ revokeFails: true })

		await expect(createMemberController(deps).remove(actor("owner"), "mem-target")).resolves.toBe(
			true,
		)

		expect(events.slice(-3)).toEqual(["commit", "revoke:user-target", "report"])
		expect(deps.reportError).toHaveBeenCalledWith(expect.any(String), expect.any(Error))
	})
})

describe("cancelling an invitation", () => {
	it("cancels a pending invitation and audits it in the same transaction", async () => {
		const { deps, events, audited } = harness()

		await expect(
			createMemberController(deps).cancelInvitation(actor("owner"), "inv-1"),
		).resolves.toBe(true)

		expect(events).toEqual(["begin", "cancel", "audit:member.invite.cancel", "commit"])
		expect(audited[0]).toEqual({
			actorId: "mem-owner",
			actorLabel: "owner@example.com",
			action: "member.invite.cancel",
			subjectType: "invitation",
			subjectId: "inv-1",
			detail: {},
		})
	})

	it("audits nothing when nothing was waiting to be cancelled", async () => {
		const { deps, events } = harness({ cancelled: false })

		await expect(
			createMemberController(deps).cancelInvitation(actor("owner"), "inv-gone"),
		).resolves.toBe(false)

		expect(events).toEqual(["begin", "cancel", "commit"])
	})

	it.each(["operator", "viewer"] as const)("refuses a %s", async (role) => {
		const { deps, events } = harness()

		await expect(
			createMemberController(deps).cancelInvitation(actor(role), "inv-1"),
		).rejects.toBeInstanceOf(ForbiddenError)

		expect(events).toEqual([])
	})
})

describe("listing members and invitations", () => {
	it("marks the owner's own row and leaves out a role this manager does not grant", async () => {
		const { deps } = harness({
			members: [
				memberRow({ id: "mem-owner", role: "owner", name: "Ada", email: "ada@example.com" }),
				memberRow(),
				memberRow({ id: "mem-odd", role: "admin" }),
			],
		})

		await expect(createMemberController(deps).list(actor("owner"))).resolves.toEqual([
			{ id: "mem-owner", name: "Ada", email: "ada@example.com", role: "owner", self: true },
			{
				id: "mem-target",
				name: "Target",
				email: "target@example.com",
				role: "operator",
				self: false,
			},
		])
	})

	it("lists invitations still waiting, leaving out one that names no role", async () => {
		const { deps } = harness({
			invitations: [invitationRow(), invitationRow({ id: "inv-2", role: null })],
		})

		await expect(createMemberController(deps).invitations(actor("owner"))).resolves.toEqual([
			{
				id: "inv-1",
				email: "new@example.com",
				role: "viewer",
				expiresAt: "2026-09-20T00:00:00.000Z",
			},
		])
	})

	it.each(["operator", "viewer"] as const)("refuses both lists to a %s", async (role) => {
		const { deps } = harness()
		const controller = createMemberController(deps)

		await expect(controller.list(actor(role))).rejects.toBeInstanceOf(ForbiddenError)
		await expect(controller.invitations(actor(role))).rejects.toBeInstanceOf(ForbiddenError)
		expect(deps.members.list).not.toHaveBeenCalled()
		expect(deps.members.listPendingInvitations).not.toHaveBeenCalled()
	})
})
