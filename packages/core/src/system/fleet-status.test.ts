import { describe, expect, it } from "vitest"
import { conditionFor, needsAttention, WORKER_STALE_AFTER_MS } from "./fleet-status"

const NOW = new Date("2026-09-06T12:00:00Z")
const ago = (ms: number) => new Date(NOW.getTime() - ms)

const server = { build: { version: "0.4.2", commit: "abc123" }, schemaVersion: "0022" }
const worker = {
	role: "worker" as const,
	version: "0.4.2",
	commit: "abc123",
	schemaVersion: "0022",
	seenAt: ago(10_000),
}

describe("whether the control plane and its worker agree", () => {
	it("is healthy when both run the same build and schema", () => {
		expect(conditionFor(server, worker, NOW)).toBe("healthy")
	})

	it("says the worker is missing when none has ever reported in", () => {
		expect(conditionFor(server, undefined, NOW)).toBe("worker-missing")
	})

	it("says the worker went quiet rather than pretending work is running", () => {
		const quiet = { ...worker, seenAt: ago(WORKER_STALE_AFTER_MS + 1_000) }

		expect(conditionFor(server, quiet, NOW)).toBe("worker-stale")
	})

	it("tolerates a single missed heartbeat rather than flapping", () => {
		const recent = { ...worker, seenAt: ago(WORKER_STALE_AFTER_MS - 1_000) }

		expect(conditionFor(server, recent, NOW)).toBe("healthy")
	})

	it("catches a worker left on the previous version during an upgrade", () => {
		expect(conditionFor(server, { ...worker, version: "0.4.1" }, NOW)).toBe("version-skew")
	})

	it("catches the same version rebuilt from a different commit", () => {
		expect(conditionFor(server, { ...worker, commit: "def456" }, NOW)).toBe("version-skew")
	})

	it("catches a worker that applied a different schema", () => {
		expect(conditionFor(server, { ...worker, schemaVersion: "0021" }, NOW)).toBe("schema-skew")
	})

	it("reports a missing worker ahead of any version comparison, since there is nothing to compare", () => {
		expect(conditionFor(server, undefined, NOW)).toBe("worker-missing")
	})

	it("marks everything except healthy as needing attention", () => {
		expect(needsAttention("healthy")).toBe(false)
		expect(needsAttention("version-skew")).toBe(true)
		expect(needsAttention("worker-missing")).toBe(true)
	})
})
