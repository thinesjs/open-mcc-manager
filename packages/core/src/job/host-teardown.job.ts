import type { Json } from "@open-mcc/db"
import type { HostTransport } from "@open-mcc/transport"
import { MCC_ARCHITECTURES, type MccArchitecture } from "../host/mcc-release"
import { tearDownHost } from "../host/teardown"
import { connectFailureReason } from "../host/unreachable"
import type { RuntimeErrorReporter } from "../log/reporters"

const NOT_FULLY_CLEANED = "Some of what was installed is still on the host."

const CLEANING_STOPPED = "Cleaning stopped before it finished."

const COULD_NOT_REACH = "Could not reach the host to clean it"

export type TeardownPayload = {
	hostId: string
	hostname: string
	port: string
	username: string
	sshKeyId: string
	hostKeyFingerprint: string
	organizationId: string
	architecture: MccArchitecture | undefined
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
		"organizationId",
	] as const
	for (const key of required) {
		if (typeof record[key] !== "string") return undefined
	}
	const value = (key: string): string => {
		const found = record[key]
		return typeof found === "string" ? found : ""
	}
	return {
		hostId: value("hostId"),
		hostname: value("hostname"),
		port: value("port"),
		username: value("username"),
		sshKeyId: value("sshKeyId"),
		hostKeyFingerprint: value("hostKeyFingerprint"),
		organizationId: value("organizationId"),
		architecture: MCC_ARCHITECTURES.find((each) => each === record.architecture),
	}
}

export type TeardownJobDeps = {
	openKey: (organizationId: string, sshKeyId: string) => Promise<{ privateKey: string } | undefined>
	connect: (options: {
		hostname: string
		port: number
		username: string
		privateKey: string
		expectedFingerprint: string
	}) => Promise<HostTransport>
	onCleaned: (
		hostId: string,
		organizationId: string,
		summary: Record<string, string>,
	) => Promise<void>
	onFailed: (hostId: string, organizationId: string, reason: string) => Promise<void>
	onError?: RuntimeErrorReporter
}

export const createHostTeardownHandler =
	(deps: TeardownJobDeps) =>
	async (data: object): Promise<void> => {
		const payload = readPayload(data)
		if (!payload) return

		const key = await deps.openKey(payload.organizationId, payload.sshKeyId)
		if (!key) {
			await deps.onFailed(
				payload.hostId,
				payload.organizationId,
				`The SSH key for this host is gone, so it cannot be reached to clean it.`,
			)
			throw new Error(`Ssh key ${payload.sshKeyId} is gone; cannot clean the host`)
		}

		let transport: HostTransport | undefined
		let recorded = false
		try {
			transport = await deps.connect({
				hostname: payload.hostname,
				port: Number.parseInt(payload.port, 10),
				username: payload.username,
				privateKey: key.privateKey,
				expectedFingerprint: payload.hostKeyFingerprint,
			})
			const report = await tearDownHost(transport, payload.architecture)
			if (report.remaining.length > 0) {
				deps.onError?.(`Host ${payload.hostId} was not fully cleaned`, report.remaining.join("; "))
				await deps.onFailed(payload.hostId, payload.organizationId, NOT_FULLY_CLEANED)
				recorded = true
				throw new Error(NOT_FULLY_CLEANED)
			}
			await deps.onCleaned(payload.hostId, payload.organizationId, {
				unitsRemoved: String(report.unitsRemoved.length),
				directoryRemoved: String(report.directoryRemoved),
				lingeringLeft: String(report.lingeringLeft),
			})
		} catch (error) {
			if (!recorded) {
				deps.onError?.(
					`Host ${payload.hostId} could not be cleaned`,
					error instanceof Error ? error : String(error),
				)
				let reason = CLEANING_STOPPED
				if (transport === undefined) {
					reason = error instanceof Error ? connectFailureReason(error) : COULD_NOT_REACH
				}
				await deps.onFailed(payload.hostId, payload.organizationId, reason)
			}
			throw error
		} finally {
			await transport?.close().catch(() => undefined)
		}
	}
