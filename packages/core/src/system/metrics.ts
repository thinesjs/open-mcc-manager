import type { ManagerMetrics } from "@open-mcc/contracts"

export type ProcessSample = {
	rssBytes: number
	heapUsedBytes: number
	heapTotalBytes: number
	externalBytes: number
	arrayBuffersBytes: number
}

export type { ManagerMetrics }

export type MetricsSource = {
	memoryUsage: () => NodeJS.MemoryUsage
	uptime: () => number
	now: () => Date
}

export const sampleManagerMetrics = (source: MetricsSource): ManagerMetrics => {
	const memory = source.memoryUsage()
	return {
		rssBytes: memory.rss,
		heapUsedBytes: memory.heapUsed,
		heapTotalBytes: memory.heapTotal,
		externalBytes: memory.external,
		arrayBuffersBytes: memory.arrayBuffers,
		uptimeSeconds: Math.floor(source.uptime()),
		sampledAt: source.now().toISOString(),
	}
}

export type GrowthVerdict = "steady" | "growing" | "insufficient-data"

export const assessHeapGrowth = (
	samples: readonly ProcessSample[],
	toleranceRatio = 0.5,
): GrowthVerdict => {
	if (samples.length < 4) return "insufficient-data"
	const half = Math.floor(samples.length / 2)
	const mean = (values: readonly ProcessSample[]) =>
		values.reduce((total, sample) => total + sample.heapUsedBytes, 0) / values.length
	const first = mean(samples.slice(0, half))
	const last = mean(samples.slice(samples.length - half))
	if (first === 0) return "insufficient-data"
	return last > first * (1 + toleranceRatio) ? "growing" : "steady"
}
