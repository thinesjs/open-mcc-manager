import { z } from "zod"

export const AUDIT_ACTIONS = [
	"host.enroll",
	"host.provision",
	"host.provision.reclaim",
	"host.retrust",
	"host.teardown.requested",
	"host.teardown",
	"host.delete",
	"instance.create",
	"instance.authenticate",
	"instance.start",
	"instance.stop",
	"instance.restart",
	"instance.remove",
	"instance.command",
	"instance.config.update",
	"instance.schedule",
	"instance.inventory.select",
	"instance.inventory.drop",
	"member.invite",
	"member.accept",
	"member.invite.cancel",
	"member.remove",
	"sshKey.create",
	"sshKey.delete",
	"notification.destination.create",
	"notification.destination.edit",
	"notification.destination.delete",
	"notification.destination.enable",
	"notification.destination.disable",
	"notification.destination.rotate",
	"notification.destination.test",
	"notification.delivery.dismiss",
	"notification.delivery.retry",
] as const

export type AuditAction = (typeof AUDIT_ACTIONS)[number]

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
