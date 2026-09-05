import { describe, expect, it } from "vitest"
import { formatBytes, formatDuration, formatMegabytes, percentOf } from "./format-bytes"

describe("formatting sizes an operator reads at a glance", () => {
	it("scales to the unit that keeps the number small", () => {
		expect(formatBytes(512)).toBe("512 B")
		expect(formatBytes(1536)).toBe("1.5 KB")
		expect(formatBytes(85549587)).toBe("81.6 MB")
	})

	it("drops the decimal once the number is large enough not to need it", () => {
		expect(formatBytes(1024 * 1024 * 150)).toBe("150 MB")
	})

	it("says nothing rather than something wrong for a missing number", () => {
		expect(formatBytes(Number.NaN)).toBe("—")
		expect(formatBytes(-1)).toBe("—")
	})

	it("reads megabytes the host reported", () => {
		expect(formatMegabytes(2048)).toBe("2.0 GB")
	})
})

describe("formatting uptime", () => {
	it("prefers the two largest units", () => {
		expect(formatDuration(90)).toBe("1m")
		expect(formatDuration(3700)).toBe("1h 1m")
		expect(formatDuration(200000)).toBe("2d 7h")
	})
})

describe("percentages", () => {
	it("never divides by zero or exceeds a hundred", () => {
		expect(percentOf(5, 0)).toBe(0)
		expect(percentOf(200, 100)).toBe(100)
		expect(percentOf(50, 200)).toBe(25)
	})
})
