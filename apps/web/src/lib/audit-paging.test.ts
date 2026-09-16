import { AUDIT_PAGE_SIZE } from "@open-mcc/contracts"
import { describe, expect, it } from "vitest"
import { auditNextDisabled, auditPagerVisible, lastAuditOffset } from "./audit-paging"

describe("where the last page of the trail starts", () => {
	it("stays on the first page while everything fits", () => {
		expect(lastAuditOffset(0)).toBe(0)
		expect(lastAuditOffset(1)).toBe(0)
		expect(lastAuditOffset(AUDIT_PAGE_SIZE)).toBe(0)
	})

	it("moves on at the first row that does not fit", () => {
		expect(lastAuditOffset(AUDIT_PAGE_SIZE + 1)).toBe(AUDIT_PAGE_SIZE)
		expect(lastAuditOffset(AUDIT_PAGE_SIZE * 2)).toBe(AUDIT_PAGE_SIZE)
		expect(lastAuditOffset(AUDIT_PAGE_SIZE * 2 + 1)).toBe(AUDIT_PAGE_SIZE * 2)
	})

	it("lands on a whole page for a total that is not a multiple of one", () => {
		expect(lastAuditOffset(137)).toBe(100)
		expect(lastAuditOffset(37)).toBe(0)
	})
})

describe("whether the reader is offered a pager at all", () => {
	it("offers none on a first page that holds everything", () => {
		expect(auditPagerVisible(0, 0)).toBe(false)
		expect(auditPagerVisible(AUDIT_PAGE_SIZE, 0)).toBe(false)
	})

	it("offers one as soon as a row does not fit", () => {
		expect(auditPagerVisible(AUDIT_PAGE_SIZE + 1, 0)).toBe(true)
	})

	it("★ keeps the pager while the reader is off page one, even after the trail shrinks under them", () => {
		expect(auditPagerVisible(40, AUDIT_PAGE_SIZE * 2)).toBe(true)
		expect(auditPagerVisible(0, AUDIT_PAGE_SIZE)).toBe(true)
	})
})

describe("when there is nothing further to page to", () => {
	it("stops at the end of a full set", () => {
		expect(auditNextDisabled(137, 100, 37)).toBe(true)
		expect(auditNextDisabled(137, 50, AUDIT_PAGE_SIZE)).toBe(false)
	})

	it("★ keeps going when the page came back shorter than the total says remains", () => {
		expect(auditNextDisabled(40, 0, 30)).toBe(false)
		expect(auditNextDisabled(AUDIT_PAGE_SIZE, 0, AUDIT_PAGE_SIZE)).toBe(true)
	})
})
