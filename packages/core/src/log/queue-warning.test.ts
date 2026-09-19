import { PgBoss } from "pg-boss"
import { describe, expect, it } from "vitest"
import { createLogger } from "./logger"
import { attachQueueWarning } from "./queue-warning"

const SQL_FRAGMENT = "SELECT id FROM notification_delivery WHERE token = $1"
const CREDENTIAL = "hunter2-not-a-real-password"

const capturing = () => {
	const lines: string[] = []
	const logger = createLogger({ level: "debug", write: (line) => lines.push(line) })
	return { lines, logger }
}

const idleBoss = () =>
	new PgBoss({ connectionString: "postgres://unused:unused@127.0.0.1:1/unused" })

describe("the shared queue warning adapter", () => {
	it("is the only warning listener on the queue it attaches to", () => {
		const boss = idleBoss()
		const listener = attachQueueWarning(boss, capturing().logger)

		const attached = boss.listeners("warning")
		expect(attached).toHaveLength(1)
		expect(attached[0]).toBe(listener)
	})

	it("logs the warning message at warn", () => {
		const { lines, logger } = capturing()
		const listener = attachQueueWarning(idleBoss(), logger)

		listener({ message: "the queue is behind", data: {} })

		const entry = JSON.parse(lines[0] ?? "{}")
		expect(entry.message).toBe("the queue is behind")
		expect(entry.level).toBe("warn")
	})

	it("never lets the payload reach the log, asserted value by value", () => {
		const { lines, logger } = capturing()
		const listener = attachQueueWarning(idleBoss(), logger)

		listener({
			message: "a query was slow",
			data: { sql: SQL_FRAGMENT, parameters: [CREDENTIAL], durationSeconds: 9 },
		})

		const written = lines.join("")
		expect(JSON.parse(written).message).toBe("a query was slow")
		expect(written).not.toContain(CREDENTIAL)
		expect(written).not.toContain(SQL_FRAGMENT)
		expect(written).not.toContain("sql")
		expect(written).not.toContain("parameters")
		expect(written).not.toContain("durationSeconds")
	})
})
