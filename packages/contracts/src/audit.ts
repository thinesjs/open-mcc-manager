import { z } from "zod"

export const AUDIT_PAGE_SIZE = 50

export const auditListInput = z.object({
	offset: z.number().int().nonnegative().default(0),
})

export type AuditListInput = z.infer<typeof auditListInput>

export const auditEventViewSchema = z.object({
	id: z.string(),
	actorLabel: z.string(),
	action: z.string(),
	subjectType: z.string(),
	subjectId: z.string(),
	detail: z.record(z.string(), z.string()),
	createdAt: z.string().datetime(),
})

export type AuditEventView = z.infer<typeof auditEventViewSchema>

export const auditPageSchema = z.object({
	items: z.array(auditEventViewSchema),
	total: z.number().int().nonnegative(),
})

export type AuditPage = z.infer<typeof auditPageSchema>
