import { afterEach, describe, expect, it, vi } from "vitest"
import {
	COMMAND_HISTORY_LIMIT,
	COMMAND_HISTORY_PREFIX,
	readCommandHistory,
	rememberCommand,
	writeCommandHistory,
} from "./command-history"

const keyFor = (instanceId: string): string => `${COMMAND_HISTORY_PREFIX}${instanceId}`

const stored = (instanceId: string): string | null =>
	window.localStorage.getItem(keyFor(instanceId))

afterEach(() => {
	vi.restoreAllMocks()
	window.localStorage.clear()
})

describe("rememberCommand", () => {
	it("puts the newest command first", () => {
		expect(rememberCommand(["/list"], "/time set day")).toEqual(["/time set day", "/list"])
	})

	it("moves a repeated command back to the front rather than duplicating it", () => {
		expect(rememberCommand(["/b", "/a"], "/a")).toEqual(["/a", "/b"])
	})

	it("ignores blank input", () => {
		expect(rememberCommand(["/a"], "   ")).toEqual(["/a"])
	})

	it("trims what it stores", () => {
		expect(rememberCommand([], "  /list  ")).toEqual(["/list"])
	})

	it("keeps only the most recent few", () => {
		const many = Array.from({ length: 20 }, (_, index) => `/c${index}`)
		const history = many.reduce<string[]>((acc, command) => rememberCommand(acc, command), [])

		expect(history).toHaveLength(COMMAND_HISTORY_LIMIT)
		expect(history[0]).toBe("/c19")
	})

	it("does not mutate the history it was given", () => {
		const original = ["/a"]
		rememberCommand(original, "/b")

		expect(original).toEqual(["/a"])
	})
})

describe("a command that carries a password", () => {
	it("is never remembered", () => {
		for (const command of ["/login hunter2", "//login hunter2", "!login hunter2", "/cp a b"]) {
			expect(rememberCommand(["/list"], command)).toEqual(["/list"])
		}
	})

	it("is still remembered when it carries no password", () => {
		expect(rememberCommand(["/list"], "/login")).toEqual(["/login", "/list"])
	})
})

describe("a command that carries a secret which is not a password", () => {
	it("is never remembered", () => {
		for (const command of [
			"/notify https://hooks.slack.com/services/T000/B000/XXXXXXXX",
			"/notify https://discord.com/api/webhooks/123/abcdef",
			"/notify https://api.telegram.org/bot123456789:AAF-abcdefghijklmnopqrstuvwxyz012345/x",
			"/env SEALBOX_KEYS=k1:AAAABBBBCCCC=",
			"/sign whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw=",
			"/mail re_abcdefghij0123456789",
			"/notify https://prod-12.westus.logic.azure.com:443/workflows/aa/triggers/manual",
			"/fetch /invoke?api-version=1&sig=zAbC123",
		]) {
			expect(rememberCommand(["/list"], command)).toEqual(["/list"])
		}
	})

	it("is remembered when the only match is a pattern too loose for the browser", () => {
		for (const command of [
			"/team join BLUE-TEAM",
			"/say bearer of bad news",
			"/say AUTH PLAIN text please",
		]) {
			expect(rememberCommand(["/list"], command)).toEqual([command, "/list"])
		}
	})
})

describe("a secret left in storage by an earlier visit", () => {
	it("is neither returned nor left on disk", () => {
		writeCommandHistory("abc123", [
			"/login hunter2",
			"/notify https://hooks.slack.com/services/T000/B000/XXXXXXXX",
			"/list",
			"/say keep me",
		])

		expect(readCommandHistory("abc123")).toEqual(["/list", "/say keep me"])
		expect(stored("abc123")).toBe("/list\n/say keep me")
		expect(readCommandHistory("abc123")).toEqual(["/list", "/say keep me"])
	})

	it("leaves a history with nothing to purge untouched", () => {
		writeCommandHistory("abc123", ["/say hi", "/list"])

		expect(readCommandHistory("abc123")).toEqual(["/say hi", "/list"])
		expect(stored("abc123")).toBe("/say hi\n/list")
	})

	it("survives storage refusing, as it does in a private window", () => {
		writeCommandHistory("abc123", ["/list"])
		const blocked = () => {
			throw new Error("blocked")
		}
		vi.spyOn(Storage.prototype, "getItem").mockImplementation(blocked)
		vi.spyOn(Storage.prototype, "setItem").mockImplementation(blocked)

		expect(readCommandHistory("abc123")).toEqual([])
		expect(() => writeCommandHistory("abc123", ["/list"])).not.toThrow()
	})
})
