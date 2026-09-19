export const DEFAULT_EXEC_CONCURRENCY = 6

export type ChannelLimiter = {
	acquire: (signal?: AbortSignal) => Promise<void>
	release: () => void
	active: () => number
	queued: () => number
}

const abandonedBy = (signal: AbortSignal): Error =>
	signal.reason instanceof Error ? signal.reason : new Error("The wait for a channel was abandoned")

export const createChannelLimiter = (limit: number): ChannelLimiter => {
	let active = 0
	const waiting: Array<() => void> = []

	return {
		acquire: (signal) =>
			new Promise<void>((resolve, reject) => {
				if (signal?.aborted) {
					reject(abandonedBy(signal))
					return
				}
				if (active < limit) {
					active += 1
					resolve()
					return
				}
				const abandon = () => {
					const index = waiting.indexOf(admit)
					if (index !== -1) waiting.splice(index, 1)
					if (signal) reject(abandonedBy(signal))
				}
				const admit = () => {
					signal?.removeEventListener("abort", abandon)
					active += 1
					resolve()
				}
				signal?.addEventListener("abort", abandon, { once: true })
				waiting.push(admit)
			}),
		release: () => {
			active = Math.max(0, active - 1)
			const next = waiting.shift()
			if (next) next()
		},
		active: () => active,
		queued: () => waiting.length,
	}
}
