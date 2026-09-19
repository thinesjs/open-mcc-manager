import { describe, expect, it } from "vitest"
import { createLogger, type Field, readLevel } from "./logger"

const collector = () => {
	const lines: string[] = []
	return { lines, write: (line: string) => void lines.push(line) }
}

const parsed = (line: string | undefined): Record<string, Field> => JSON.parse(line ?? "{}")

const at = () => new Date("2026-09-07T12:00:00.000Z")

describe("what a log line looks like", () => {
	it("is one json object per line, ending in a newline", () => {
		const { lines, write } = collector()
		createLogger({ write, now: at }).info("delivery settled")

		expect(lines).toHaveLength(1)
		expect(lines[0]?.endsWith("\n")).toBe(true)
		expect(lines[0]?.slice(0, -1).includes("\n")).toBe(false)
		expect(parsed(lines[0])).toEqual({
			time: "2026-09-07T12:00:00.000Z",
			level: "info",
			message: "delivery settled",
		})
	})

	it("keeps the caller's fields alongside, so they can be searched on", () => {
		const { lines, write } = collector()
		createLogger({ write, now: at }).info("delivery settled", {
			destination_kind: "gotify",
			attempts: 3,
			delivered: true,
		})

		expect(parsed(lines[0])).toMatchObject({
			destination_kind: "gotify",
			attempts: 3,
			delivered: true,
		})
	})

	it("names the service when it is told one", () => {
		const { lines, write } = collector()
		createLogger({ write, now: at, service: "worker" }).info("started")
		expect(parsed(lines[0]).service).toBe("worker")
	})
})

describe("which lines get written at all", () => {
	it("drops anything below the threshold", () => {
		const { lines, write } = collector()
		const log = createLogger({ write, now: at, level: "warn" })

		log.debug("a")
		log.info("b")
		log.warn("c")
		log.error("d")

		expect(lines.map((line) => parsed(line).level)).toEqual(["warn", "error"])
	})

	it("defaults to info, so debug is off unless asked for", () => {
		const { lines, write } = collector()
		const log = createLogger({ write, now: at })

		log.debug("quiet")
		log.info("loud")

		expect(lines.map((line) => parsed(line).message)).toEqual(["loud"])
	})

	it("reads a level from the environment without trusting it", () => {
		expect(readLevel("debug")).toBe("debug")
		expect(readLevel(" WARN ")).toBe("warn")
		expect(readLevel("verbose")).toBe("info")
		expect(readLevel(undefined)).toBe("info")
		expect(readLevel("")).toBe("info")
	})
})

describe("a logger that carries context", () => {
	it("adds the child's fields to every line", () => {
		const { lines, write } = collector()
		const log = createLogger({ write, now: at }).child({ delivery_id: "dlv_1" })

		log.info("attempting")
		log.error("gave up")

		expect(parsed(lines[0]).delivery_id).toBe("dlv_1")
		expect(parsed(lines[1]).delivery_id).toBe("dlv_1")
	})

	it("lets a call site override an inherited field rather than duplicating it", () => {
		const { lines, write } = collector()
		createLogger({ write, now: at }).child({ attempt: 1 }).info("retrying", { attempt: 2 })

		expect(parsed(lines[0]).attempt).toBe(2)
	})

	it("nests, so a request logger can hand one to a delivery", () => {
		const { lines, write } = collector()
		createLogger({ write, now: at })
			.child({ request_id: "req_1" })
			.child({ delivery_id: "dlv_1" })
			.info("sending")

		expect(parsed(lines[0])).toMatchObject({ request_id: "req_1", delivery_id: "dlv_1" })
	})
})

describe("correlating a line with its trace", () => {
	it("carries the ids when a span is active", () => {
		const { lines, write } = collector()
		createLogger({
			write,
			now: at,
			activeTrace: () => ({
				trace_id: "4bf92f3577b34da6a3ce929d0e0e4736",
				span_id: "00f067aa0ba902b7",
			}),
		}).info("in a span")

		const line = parsed(lines[0])
		expect(line.trace_id).toBe("4bf92f3577b34da6a3ce929d0e0e4736")
		expect(line.span_id).toBe("00f067aa0ba902b7")
	})

	it("writes raw lowercase hex of the lengths a trace store expects", () => {
		const { lines, write } = collector()
		createLogger({
			write,
			now: at,
			activeTrace: () => ({
				trace_id: "4bf92f3577b34da6a3ce929d0e0e4736",
				span_id: "00f067aa0ba902b7",
			}),
		}).info("in a span")

		const line = parsed(lines[0])
		expect(String(line.trace_id)).toMatch(/^[0-9a-f]{32}$/)
		expect(String(line.span_id)).toMatch(/^[0-9a-f]{16}$/)
	})

	it("omits the ids entirely when nothing is active, rather than writing empty ones", () => {
		const { lines, write } = collector()
		createLogger({ write, now: at, activeTrace: () => undefined }).info("outside a span")

		const line = parsed(lines[0])
		expect("trace_id" in line).toBe(false)
		expect("span_id" in line).toBe(false)
	})
})

describe("a log line is not a new way to leak a secret", () => {
	it("redacts a credential that reaches the message", () => {
		const { lines, write } = collector()
		createLogger({ write, now: at }).error(
			"could not reach https://hooks.slack.com/services/T/B/xoxb-secret-path",
		)

		const line = String(parsed(lines[0]).message)
		expect(line).not.toContain("xoxb-secret-path")
		expect(line).toContain("[redacted]")
	})

	it("redacts a credential that reaches a field", () => {
		const { lines, write } = collector()
		createLogger({ write, now: at }).error("failed", {
			target: "https://discord.com/api/webhooks/1/discord-token",
			auth: "Bearer sk-do-not-log-this",
		})

		const line = parsed(lines[0])
		expect(String(line.target)).not.toContain("discord-token")
		expect(String(line.auth)).not.toContain("sk-do-not-log-this")
	})

	it("leaves a non-string field alone rather than stringifying it", () => {
		const { lines, write } = collector()
		createLogger({ write, now: at }).info("counted", { attempts: 8, ok: false, reason: null })

		expect(parsed(lines[0])).toMatchObject({ attempts: 8, ok: false, reason: null })
	})
})
