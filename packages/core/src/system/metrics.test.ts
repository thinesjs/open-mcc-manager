import { describe, expect, it } from "vitest"
import { parseHostMetrics } from "./host-metrics"
import { assessHeapGrowth, type ProcessSample, sampleManagerMetrics } from "./metrics"

const usage = (heapUsed: number): NodeJS.MemoryUsage => ({
	rss: 100,
	heapTotal: 200,
	heapUsed,
	external: 10,
	arrayBuffers: 5,
})

const sample = (heapUsedBytes: number): ProcessSample => ({
	rssBytes: 0,
	heapUsedBytes,
	heapTotalBytes: 0,
	externalBytes: 0,
	arrayBuffersBytes: 0,
})

describe("manager metrics", () => {
	it("reports what the process actually uses", () => {
		const metrics = sampleManagerMetrics({
			memoryUsage: () => usage(150),
			uptime: () => 61.9,
			now: () => new Date("2026-09-05T00:00:00Z"),
		})

		expect(metrics.heapUsedBytes).toBe(150)
		expect(metrics.uptimeSeconds).toBe(61)
	})
})

describe("judging heap growth", () => {
	it("refuses to judge from too few samples", () => {
		expect(assessHeapGrowth([sample(1), sample(2)])).toBe("insufficient-data")
	})

	it("calls a flat heap steady, including ordinary sawtooth", () => {
		const sawtooth = [100, 140, 90, 150, 95, 145, 100, 150].map(sample)
		expect(assessHeapGrowth(sawtooth)).toBe("steady")
	})

	it("calls a heap that keeps climbing growing", () => {
		const climbing = [100, 200, 300, 400, 500, 600, 700, 800].map(sample)
		expect(assessHeapGrowth(climbing)).toBe("growing")
	})
})

describe("host metrics", () => {
	it("reads what the kernel reports, in the units an operator expects", () => {
		const metrics = parseHostMetrics(
			["0.42", "8069260 5943104", "123456.78"].join("\n"),
			"/dev/sda1 41922560 8388608 33533952 20% /",
		)

		expect(metrics.loadAverage1m).toBeCloseTo(0.42)
		expect(metrics.memoryTotalMb).toBe(7880)
		expect(metrics.memoryUsedMb).toBe(2076)
		expect(metrics.diskTotalMb).toBe(40940)
		expect(metrics.diskUsedMb).toBe(8192)
		expect(metrics.uptimeSeconds).toBe(123456)
	})

	it("does not invent numbers when the host answers with nothing", () => {
		const metrics = parseHostMetrics("", "")
		expect(metrics.memoryTotalMb).toBe(0)
		expect(metrics.loadAverage1m).toBe(0)
	})
})
