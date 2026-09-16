import type { AuditAction, AuditEventView } from "@open-mcc/contracts"

type Template = (subject: string) => string

const TEMPLATES: Record<AuditAction, Template> = {
	"host.enroll": (subject) => `enrolled the host ${subject}.`,
	"host.provision": (subject) => `set up the host ${subject}.`,
	"host.provision.reclaim": (subject) => `took over a stalled setup of the host ${subject}.`,
	"host.retrust": (subject) => `trusted a new key for the host ${subject}.`,
	"host.teardown.requested": (subject) => `asked to clean up the host ${subject}.`,
	"host.teardown": (subject) => `finished cleaning up the host ${subject}.`,
	"host.delete": (subject) => `removed the host ${subject}.`,
	"instance.create": (subject) => `created the instance ${subject}.`,
	"instance.authenticate": (subject) => `signed in the instance ${subject}.`,
	"instance.start": (subject) => `started the instance ${subject}.`,
	"instance.stop": (subject) => `stopped the instance ${subject}.`,
	"instance.restart": (subject) => `restarted the instance ${subject}.`,
	"instance.remove": (subject) => `removed the instance ${subject}.`,
	"instance.command": (subject) => `sent a command to the instance ${subject}.`,
	"instance.config.update": (subject) => `changed the settings of the instance ${subject}.`,
	"instance.schedule": (subject) => `changed a scheduled command on the instance ${subject}.`,
	"instance.inventory.select": (subject) => `held an item on the instance ${subject}.`,
	"instance.inventory.drop": (subject) => `dropped an item from the instance ${subject}.`,
	"member.invite": (subject) => `invited ${subject}.`,
	"member.accept": () => "joined the organization.",
	"member.invite.cancel": (subject) => `cancelled the invitation to ${subject}.`,
	"member.remove": (subject) => `removed the member ${subject}.`,
	"sshKey.create": (subject) => `generated the SSH key ${subject}.`,
	"sshKey.delete": (subject) => `deleted the SSH key ${subject}.`,
	"notification.destination.create": (subject) => `added the alert destination ${subject}.`,
	"notification.destination.edit": (subject) => `changed the alert destination ${subject}.`,
	"notification.destination.delete": (subject) => `removed the alert destination ${subject}.`,
	"notification.destination.enable": (subject) => `turned on the alert destination ${subject}.`,
	"notification.destination.disable": (subject) => `turned off the alert destination ${subject}.`,
	"notification.destination.rotate": (subject) => `rotated the signing secret of ${subject}.`,
	"notification.destination.test": (subject) => `sent a test alert to ${subject}.`,
	"notification.delivery.dismiss": (subject) => `dismissed a failed alert to ${subject}.`,
	"notification.delivery.retry": (subject) => `retried a failed alert to ${subject}.`,
}

const BY_ACTION: Record<string, Template | undefined> = TEMPLATES

const NAME_KEYS = ["name", "hostname", "email", "minecraftAccount"] as const

export const auditSubject = (event: Pick<AuditEventView, "subjectId" | "detail">): string => {
	for (const key of NAME_KEYS) {
		const named = event.detail[key]
		if (named !== undefined && named.trim().length > 0) return named
	}
	return event.subjectId
}

export const describeAuditAction = (action: string, subject: string): string =>
	BY_ACTION[action]?.(subject) ?? `${action.replaceAll(".", " ")} ${subject}.`

export const describeAuditEvent = (event: AuditEventView): string =>
	`${event.actorLabel} ${describeAuditAction(event.action, auditSubject(event))}`
