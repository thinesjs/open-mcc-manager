import type { Json } from "@open-mcc/db"
import type { HostTransport } from "@open-mcc/transport"
import { profileFrom } from "../host/profile"
import { tearDownHost } from "../host/teardown"

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
	organizationId: string
}

export const readPayload = (payload: object): TeardownPayload | undefined => {
	if (payload === null || Array.isArray(payload)) return undefined
	const record: Record<string, Json | undefined> = { ...payload }
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
		"organizationId",
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
		organizationId: value("organizationId"),
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
	async (data: object): Promise<void> => {
		const payload = readPayload(data)
		if (!payload) return

		const key = await deps.openKey(payload.organizationId, payload.sshKeyId)
		if (!key) throw new Error(`Ssh key ${payload.sshKeyId} is gone; cannot clean the host`)

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
			if (report.remaining.length > 0) {
				throw new Error(`Host was not fully cleaned: ${report.remaining.join("; ")}`)
			}
		} finally {
			await transport?.close().catch(() => undefined)
		}
	}
