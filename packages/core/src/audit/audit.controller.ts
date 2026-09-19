import {
	AUDIT_PAGE_SIZE,
	type AuditEventView,
	type AuditListInput,
	type AuditPage,
	can,
} from "@open-mcc/contracts"
import type { AuditEventRow, Db } from "@open-mcc/db"
import { type ActorContext, ForbiddenError } from "../host/host.controller"
import { type AuditRepository, createAuditRepository } from "./audit.repository"

export type AuditTransactionRepos = {
	audit: Pick<AuditRepository, "list" | "count">
}

export type WithAuditTransaction = <T>(
	fn: (repos: AuditTransactionRepos) => Promise<T>,
) => Promise<T>

export const createAuditControllerTransaction = (db: Db): WithAuditTransaction => {
	const withTransaction: WithAuditTransaction = (fn) =>
		db.transaction().execute((tx) => fn({ audit: createAuditRepository(tx) }))
	return withTransaction
}

export type AuditControllerDeps = {
	withTransaction: WithAuditTransaction
}

const requireCapabilityFor = (ctx: ActorContext): void => {
	if (!can(ctx.role, "audit.read")) throw new ForbiddenError("Forbidden: audit.read")
}

const toView = (row: AuditEventRow): AuditEventView => ({
	id: row.id,
	actorLabel: row.actorLabel,
	action: row.action,
	subjectType: row.subjectType,
	subjectId: row.subjectId,
	detail: row.detail,
	createdAt: row.createdAt.toISOString(),
})

export const createAuditController = (deps: AuditControllerDeps) => ({
	list: async (ctx: ActorContext, input: AuditListInput): Promise<AuditPage> => {
		requireCapabilityFor(ctx)
		const scope = { organizationId: ctx.organizationId }
		return deps.withTransaction(async (repos) => {
			const rows = await repos.audit.list(scope, {
				limit: AUDIT_PAGE_SIZE,
				offset: input.offset,
			})
			return { items: rows.map(toView), total: await repos.audit.count(scope) }
		})
	},
})

export type AuditController = ReturnType<typeof createAuditController>
