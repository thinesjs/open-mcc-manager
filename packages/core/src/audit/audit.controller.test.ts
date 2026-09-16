import { AUDIT_PAGE_SIZE, type Role } from "@open-mcc/contracts"
import type { AuditEventRow } from "@open-mcc/db"
import { describe, expect, it, vi } from "vitest"
import { type ActorContext, ForbiddenError } from "../host/host.controller"
import {
	type AuditControllerDeps,
	type AuditTransactionRepos,
	createAuditController,
} from "./audit.controller"
import type { AuditPageRequest } from "./audit.repository"

const RECORDED_AT = new Date("2026-09-06T12:00:00.000Z")
const TOTAL = AUDIT_PAGE_SIZE * 2 + 7

const actor = (role: Role): ActorContext => ({
	organizationId: "org-1",
	memberId: "mem-1",
	actorLabel: "owner@example.com",
	role,
})

const storedRow = (index: number): AuditEventRow => ({
	id: `evt-${index}`,
	organizationId: "org-1",
	actorId: null,
	actorLabel: "system",
	action: "host.enroll",
	subjectType: "host",
	subjectId: `host-${index}`,
	detail: { hostname: `box-${index}` },
	createdAt: RECORDED_AT,
})

type Harness = {
	deps: AuditControllerDeps
	pages: AuditPageRequest[]
	transactions: () => number
}

const harness = (): Harness => {
	const pages: AuditPageRequest[] = []
	const state = { transactions: 0 }
	const repos: AuditTransactionRepos = {
		audit: {
			list: vi.fn(async (_scope, page: AuditPageRequest) => {
				pages.push(page)
				const remaining = Math.max(0, TOTAL - page.offset)
				return Array.from({ length: Math.min(page.limit, remaining) }, (_entry, index) =>
					storedRow(page.offset + index),
				)
			}),
			count: vi.fn(async () => TOTAL),
		},
	}
	return {
		deps: {
			withTransaction: async (fn) => {
				state.transactions += 1
				return fn(repos)
			},
		},
		pages,
		transactions: () => state.transactions,
	}
}

describe("who may read the audit trail", () => {
	it("gives an owner the page and the whole total", async () => {
		const harnessed = harness()
		const controller = createAuditController(harnessed.deps)

		const page = await controller.list(actor("owner"), { offset: 0 })

		expect(page.total).toBe(TOTAL)
		expect(page.items).toHaveLength(AUDIT_PAGE_SIZE)
		expect(page.items[0]?.createdAt).toBe("2026-09-06T12:00:00.000Z")
		expect(harnessed.transactions()).toBe(1)
	})

	it("refuses an operator and a viewer, because the trail carries member activity", async () => {
		const controller = createAuditController(harness().deps)

		await expect(controller.list(actor("operator"), { offset: 0 })).rejects.toBeInstanceOf(
			ForbiddenError,
		)
		await expect(controller.list(actor("viewer"), { offset: 0 })).rejects.toBeInstanceOf(
			ForbiddenError,
		)
	})

	it("reads nothing at all for a role without the capability", async () => {
		const harnessed = harness()
		const controller = createAuditController(harnessed.deps)

		await expect(controller.list(actor("viewer"), { offset: 0 })).rejects.toBeInstanceOf(
			ForbiddenError,
		)
		expect(harnessed.transactions()).toBe(0)
	})
})

describe("what the reader sees while paging", () => {
	it("keeps the total the same on every page, and never asks for an uncapped read", async () => {
		const harnessed = harness()
		const controller = createAuditController(harnessed.deps)

		const first = await controller.list(actor("owner"), { offset: 0 })
		const second = await controller.list(actor("owner"), { offset: AUDIT_PAGE_SIZE })
		const last = await controller.list(actor("owner"), { offset: AUDIT_PAGE_SIZE * 2 })

		expect([first.total, second.total, last.total]).toEqual([TOTAL, TOTAL, TOTAL])
		expect(last.items).toHaveLength(7)
		expect(harnessed.pages).toEqual([
			{ limit: AUDIT_PAGE_SIZE, offset: 0 },
			{ limit: AUDIT_PAGE_SIZE, offset: AUDIT_PAGE_SIZE },
			{ limit: AUDIT_PAGE_SIZE, offset: AUDIT_PAGE_SIZE * 2 },
		])
	})

	it("hands on the recorded detail and never records a read of its own", async () => {
		const controller = createAuditController(harness().deps)

		const page = await controller.list(actor("owner"), { offset: 0 })

		expect(page.items[0]?.detail).toEqual({ hostname: "box-0" })
		expect(Object.keys(controller)).toEqual(["list"])
	})
})
