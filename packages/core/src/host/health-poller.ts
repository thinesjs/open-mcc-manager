import type { HostRow } from "@open-mcc/db"
import type { HostTransport } from "@open-mcc/transport"
import { HEALTH_POLL_MS, type HostObservationResult, observeHost } from "./health"
import { profileFrom } from "./profile"

export type HealthPollerDeps = {
	pollableHosts: () => Promise<HostRow[]>
	connect: (host: HostRow) => Promise<HostTransport>
	recordSeen: (host: HostRow, seenAt: Date, observed: HostObservationResult) => Promise<void>
	now: () => Date
	onError?: (message: string, error: Error | string) => void
}

export type HealthPollRun = {
	polled: number
	reached: string[]
	unreachable: string[]
}

export const isPollable = (host: HostRow): boolean =>
	host.status === "ready" && host.instancesRoot !== null && host.unitDir !== null

export const runHealthPoll = async (deps: HealthPollerDeps): Promise<HealthPollRun> => {
	const hosts = (await deps.pollableHosts()).filter(isPollable)
	const run: HealthPollRun = { polled: hosts.length, reached: [], unreachable: [] }

	for (const host of hosts) {
		if (!host.instancesRoot || !host.unitDir) continue
		let transport: HostTransport | undefined
		try {
			const profile = profileFrom(host.mode, host.instancesRoot, host.unitDir)
			transport = await deps.connect(host)
			const observed = await observeHost(transport, profile)
			await deps.recordSeen(host, deps.now(), observed)
			run.reached.push(host.id)
		} catch (error) {
			run.unreachable.push(host.id)
			deps.onError?.(
				`Health poll could not reach host ${host.id}`,
				error instanceof Error ? error : String(error),
			)
		} finally {
			await transport?.close().catch(() => undefined)
		}
	}

	return run
}

export type HealthPollerHandle = { stop: () => void }

export const startHealthPoller = (
	deps: HealthPollerDeps,
	intervalMs: number = HEALTH_POLL_MS,
): HealthPollerHandle => {
	let running = false
	const tick = async () => {
		if (running) return
		running = true
		try {
			await runHealthPoll(deps)
		} catch (error) {
			deps.onError?.("Health poll failed", error instanceof Error ? error : String(error))
		} finally {
			running = false
		}
	}
	const timer = setInterval(() => {
		void tick()
	}, intervalMs)
	timer.unref?.()
	return { stop: () => clearInterval(timer) }
}
