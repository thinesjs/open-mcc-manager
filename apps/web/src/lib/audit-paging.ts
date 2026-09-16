import { AUDIT_PAGE_SIZE } from "@open-mcc/contracts"

export const lastAuditOffset = (total: number): number =>
	total === 0 ? 0 : Math.floor((total - 1) / AUDIT_PAGE_SIZE) * AUDIT_PAGE_SIZE

export const auditPagerVisible = (total: number, offset: number): boolean =>
	total > AUDIT_PAGE_SIZE || offset > 0

export const auditNextDisabled = (total: number, offset: number, shown: number): boolean =>
	offset + shown >= total
