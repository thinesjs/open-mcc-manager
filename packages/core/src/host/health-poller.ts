import type { HostRow } from "@open-mcc/db"
import type { HostTransport } from "@open-mcc/transport"
import { HEALTH_POLL_MS, type HostObservationResult, observeHost } from "./health"

export type HealthPollerDeps = {
	pollableHosts: () => Promise<HostRow[]>
	connect: (host: HostRow) => Promise<HostTransport>
	recordSeen: (host: HostRow, seenAt: Date, observed: HostObservationResult) => Promise<void>
	recordReachability?: (host: HostRow, reached: boolean) => Promise<void>
	observeInstances?: (host: HostRow, transport: HostTransport) => Promise<void>
	now: () => Date
	onError?: (message: string, error: Error | string) => void
}

export type HealthPollRun = {
	polled: number
	reached: string[]
	unreachable: string[]
}

export const isPollable = (host: HostRow): boolean => host.status === "ready"

export const runHealthPoll = async (deps: HealthPollerDeps): Promise<HealthPollRun> => {
	const hosts = (await deps.pollableHosts()).filter(isPollable)
	const run: HealthPollRun = { polled: hosts.length, reached: [], unreachable: [] }

	for (const host of hosts) {
		let transport: HostTransport | undefined
		try {
			transport = await deps.connect(host)
			const observed = await observeHost(transport)
			await deps.recordSeen(host, deps.now(), observed)
			run.reached.push(host.id)
			await deps.recordReachability?.(host, true)
			try {
				await deps.observeInstances?.(host, transport)
			} catch (error) {
				deps.onError?.(
					`Could not read the bots on host ${host.id}`,
					error instanceof Error ? error : String(error),
				)
			}
		} catch (error) {
			run.unreachable.push(host.id)
			deps.onError?.(
				`Health poll could not reach host ${host.id}`,
				error instanceof Error ? error : String(error),
			)
			try {
				await deps.recordReachability?.(host, false)
			} catch (recordError) {
				deps.onError?.(
					`Could not record that host ${host.id} was unreachable`,
					recordError instanceof Error ? recordError : String(recordError),
				)
			}
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
