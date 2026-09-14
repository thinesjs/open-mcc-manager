import type { HostRow } from "@open-mcc/db"
import {
	HEALTH_POLL_MS,
	HEALTH_TIMEOUT_MS,
	type HostObservationResult,
	observeHost,
} from "./health"
import type { HostReadLease } from "./host-reader"

export type LeaseHost = (deadlineMs: number) => Promise<HostReadLease>

export type HealthPollerDeps = {
	pollableHosts: () => Promise<HostRow[]>
	lease: (host: HostRow, deadlineMs: number) => Promise<HostReadLease>
	recordSeen: (host: HostRow, seenAt: Date, observed: HostObservationResult) => Promise<void>
	recordReachability?: (host: HostRow, reached: boolean) => Promise<void>
	observeInstances?: (host: HostRow, lease: LeaseHost) => Promise<void>
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

	for (const listed of hosts) {
		try {
			const leased = await deps.lease(listed, HEALTH_TIMEOUT_MS)
			if (leased.kind !== "leased") continue
			let observed: HostObservationResult
			try {
				observed = await observeHost(leased.reader)
			} finally {
				leased.reader.release()
			}
			const host = leased.host
			await deps.recordSeen(host, deps.now(), observed)
			run.reached.push(host.id)
			await deps.recordReachability?.(host, true)
			try {
				await deps.observeInstances?.(host, (deadlineMs) => deps.lease(host, deadlineMs))
			} catch (error) {
				deps.onError?.(
					`Could not read the bots on host ${host.id}`,
					error instanceof Error ? error : String(error),
				)
			}
		} catch (error) {
			run.unreachable.push(listed.id)
			deps.onError?.(
				`Health poll could not reach host ${listed.id}`,
				error instanceof Error ? error : String(error),
			)
			try {
				await deps.recordReachability?.(listed, false)
			} catch (recordError) {
				deps.onError?.(
					`Could not record that host ${listed.id} was unreachable`,
					recordError instanceof Error ? recordError : String(recordError),
				)
			}
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
