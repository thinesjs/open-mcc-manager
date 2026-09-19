import type { Json } from "@open-mcc/db"

export type EscalationPayload = {
	organizationId: string
	instanceId: string
	incidentId: string
}

export const readEscalationPayload = (payload: object): EscalationPayload | undefined => {
	if (payload === null || Array.isArray(payload)) return undefined
	const record: Record<string, Json | undefined> = { ...payload }
	const required = ["organizationId", "instanceId", "incidentId"] as const
	for (const key of required) {
		const value = record[key]
		if (typeof value !== "string" || value.length === 0) return undefined
	}
	const value = (key: string): string => {
		const found = record[key]
		return typeof found === "string" ? found : ""
	}
	return {
		organizationId: value("organizationId"),
		instanceId: value("instanceId"),
		incidentId: value("incidentId"),
	}
}

export type EscalationDeps = {
	escalate: (
		scope: { organizationId: string },
		instanceId: string,
		incidentId: string,
	) => Promise<boolean>
}

export const createEscalationHandler =
	(deps: EscalationDeps) =>
	async (payload: object): Promise<boolean> => {
		const read = readEscalationPayload(payload)
		if (!read) return false
		return await deps.escalate(
			{ organizationId: read.organizationId },
			read.instanceId,
			read.incidentId,
		)
	}
