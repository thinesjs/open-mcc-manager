import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

const source = readFileSync(join(__dirname, "..", "components", "live-connection.tsx"), "utf8")

describe("the live state a bot reports", () => {
	it("★ leaves out who the bot is signed in as when the client gave no name it could read", () => {
		const row = source.indexOf("Signed in as")

		expect(row).toBeGreaterThan(-1)
		expect(source.slice(Math.max(0, row - 160), row)).toContain("{liveStatus.username ? (")
	})
})
