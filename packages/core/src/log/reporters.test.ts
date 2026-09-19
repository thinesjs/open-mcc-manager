import { describe, expect, it } from "vitest"
import { createLogger } from "./logger"
import {
	lockLostHandler,
	retentionSweepJob,
	retentionSweepReporter,
	runtimeErrorReporter,
} from "./reporters"

const capturing = () => {
	const lines: string[] = []
	return { lines, logger: createLogger({ level: "debug", write: (line) => lines.push(line) }) }
}

const only = (lines: readonly string[]) => JSON.parse(lines[0] ?? "{}")

describe("the reporter a continuing runtime path hands its failures to", () => {
	it("logs at error, keeping the message the caller chose", () => {
		const { lines, logger } = capturing()

		runtimeErrorReporter(logger)("Scheduled command failed", new Error("boom"))

		expect(only(lines).level).toBe("error")
		expect(only(lines).message).toBe("Scheduled command failed")
	})

	it("carries a string error through instead of repeating the message, which the old code discarded", () => {
		const { lines, logger } = capturing()

		runtimeErrorReporter(logger)("Health poll failed", "the host refused the connection")

		expect(only(lines).detail).toBe("the host refused the connection")
	})

	it("redacts a credential an Error happened to carry", () => {
		const { lines, logger } = capturing()

		runtimeErrorReporter(logger)("Delivery failed", new Error("Bearer abc123def456ghi789"))

		expect(lines.join("")).not.toContain("abc123def456ghi789")
	})
})

describe("the reporter the retention sweep hands its count to", () => {
	it("logs the count at info when it removed something", () => {
		const { lines, logger } = capturing()

		retentionSweepReporter(logger)(3)

		expect(only(lines).level).toBe("info")
		expect(only(lines).message).toBe("Removed 3 notifications past retention")
	})

	it("says nothing when it removed nothing, so a nightly sweep is not noise", () => {
		const { lines, logger } = capturing()

		retentionSweepReporter(logger)(0)

		expect(lines).toEqual([])
	})
})

describe("the cleanup job the worker registers on its retention queue", () => {
	it("hands the swept count to its reporter, so the sweep cannot run silently", async () => {
		const seen: number[] = []

		await retentionSweepJob(
			async () => 7,
			(removed) => seen.push(removed),
		)()

		expect(seen).toEqual([7])
	})

	it("reports through the real reporter, logging the count at info", async () => {
		const { lines, logger } = capturing()

		await retentionSweepJob(async () => 2, retentionSweepReporter(logger))()

		expect(only(lines).level).toBe("info")
		expect(only(lines).message).toBe("Removed 2 notifications past retention")
	})
})

describe("what happens when the control plane loses its singleton lock", () => {
	it("says so at error before quiescing, so the exit is not silent", () => {
		const { lines, logger } = capturing()

		lockLostHandler(
			logger,
			() => undefined,
			() => undefined,
		)()

		expect(only(lines).level).toBe("error")
		expect(only(lines).message).toBe("Singleton lock lost; quiescing and exiting")
	})

	it("closes the server and then exits, in that order", () => {
		const order: string[] = []

		lockLostHandler(
			capturing().logger,
			() => order.push("closed"),
			() => order.push("exited"),
		)()

		expect(order).toEqual(["closed", "exited"])
	})
})
