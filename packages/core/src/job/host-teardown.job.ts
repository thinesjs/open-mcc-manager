import type { JobRow, Json, JsonObject } from "@open-mcc/db"
import type { HostTransport } from "@open-mcc/transport"
import { profileFrom } from "../host/profile"
import { tearDownHost } from "../host/teardown"
import type { JobOutcome } from "./job-runner"

export const HOST_TEARDOWN_KIND = "host.teardown"

export type TeardownPayload = {
	hostId: string
	hostname: string
	port: string
	username: string
	sshKeyId: string
	hostKeyFingerprint: string
	mode: string
	instancesRoot: string
	unitDir: string
	instanceIds: string
}

export const readPayload = (payload: Json): TeardownPayload | undefined => {
	if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return undefined
	const record: JsonObject = payload
	const required = [
		"hostId",
		"hostname",
		"port",
		"username",
		"sshKeyId",
		"hostKeyFingerprint",
		"mode",
		"instancesRoot",
		"unitDir",
	] as const
	for (const key of required) {
		if (typeof record[key] !== "string") return undefined
	}
	const value = (key: string): string => {
		const found = record[key]
		return typeof found === "string" ? found : ""
	}
	if (value("mode") !== "rootless" && value("mode") !== "system") return undefined
	return {
		hostId: value("hostId"),
		hostname: value("hostname"),
		port: value("port"),
		username: value("username"),
		sshKeyId: value("sshKeyId"),
		hostKeyFingerprint: value("hostKeyFingerprint"),
		mode: value("mode"),
		instancesRoot: value("instancesRoot"),
		unitDir: value("unitDir"),
		instanceIds: value("instanceIds"),
	}
}

export const instanceIdsFrom = (value: string): string[] =>
	value
		.split(",")
		.map((each) => each.trim())
		.filter((each) => each.length > 0)

export type TeardownJobDeps = {
	openKey: (organizationId: string, sshKeyId: string) => Promise<{ privateKey: string } | undefined>
	connect: (options: {
		hostname: string
		port: number
		username: string
		privateKey: string
		expectedFingerprint: string
	}) => Promise<HostTransport>
	onCleaned: (hostId: string, summary: Record<string, string>) => Promise<void>
}

export const createHostTeardownHandler =
	(deps: TeardownJobDeps) =>
	async (job: JobRow): Promise<JobOutcome> => {
		const payload = readPayload(job.payload)
		if (!payload) return "abandon"

		const key = await deps.openKey(job.organizationId, payload.sshKeyId)
		if (!key) return "abandon"

		const profile = profileFrom(
			payload.mode === "system" ? "system" : "rootless",
			payload.instancesRoot,
			payload.unitDir,
		)

		let transport: HostTransport | undefined
		try {
			transport = await deps.connect({
				hostname: payload.hostname,
				port: Number.parseInt(payload.port, 10),
				username: payload.username,
				privateKey: key.privateKey,
				expectedFingerprint: payload.hostKeyFingerprint,
			})
			const report = await tearDownHost(transport, profile, instanceIdsFrom(payload.instanceIds))
			await deps.onCleaned(payload.hostId, {
				unitsRemoved: String(report.unitsRemoved.length),
				accountsRemoved: String(report.accountsRemoved.length),
				directoryRemoved: String(report.directoryRemoved),
				lingeringLeft: String(report.lingeringLeft),
				remaining: report.remaining.join("; "),
			})
			return report.remaining.length === 0 ? "done" : "retry"
		} finally {
			await transport?.close().catch(() => undefined)
		}
	}
