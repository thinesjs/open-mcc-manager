import type { AuditEventRow } from "@open-mcc/db"
import type { AuditEntry } from "../audit/audit.repository"
import type { HostRepository } from "../host/host.repository"
import { InternalError } from "../lib/errors"

const refuse =
	<T>(name: string): (() => Promise<T>) =>
	() =>
		Promise.reject(new InternalError(`hosts.${name} was not expected here`))

export const unusedHostRepository = (): HostRepository => ({
	beginTeardown: refuse("beginTeardown"),
	recordTeardownFailure: refuse("recordTeardownFailure"),
	deleteAfterTeardown: refuse("deleteAfterTeardown"),
	listPollableAcrossOrganizations: refuse("listPollableAcrossOrganizations"),
	recordSeen: refuse("recordSeen"),
	insert: refuse("insert"),
	findById: refuse("findById"),
	list: refuse("list"),
	update: refuse("update"),
	delete: refuse("delete"),
	recordProvisioningProgress: refuse("recordProvisioningProgress"),
	recordProvisioningFailure: refuse("recordProvisioningFailure"),
	lockHost: refuse("lockHost"),
	instanceCount: refuse("instanceCount"),
	claimForProvisioning: refuse("claimForProvisioning"),
	finalizeProvisioning: refuse("finalizeProvisioning"),
	updateHostKeyTrust: refuse("updateHostKeyTrust"),
})

export const auditRowFor = (organizationId: string, entry: AuditEntry): AuditEventRow => ({
	id: "audit-double",
	organizationId,
	actorId: entry.actorId,
	actorLabel: entry.actorLabel,
	action: entry.action,
	subjectType: entry.subjectType,
	subjectId: entry.subjectId,
	detail: entry.detail,
	createdAt: new Date(),
})
