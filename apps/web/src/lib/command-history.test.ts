import { afterEach, describe, expect, it, vi } from "vitest"
import {
	COMMAND_HISTORY_LIMIT,
	readCommandHistory,
	rememberCommand,
	writeCommandHistory,
} from "./command-history"

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

describe("a password left in storage by an earlier visit", () => {
	const stub = () => {
		const entries = new Map<string, string>()
		vi.stubGlobal("window", {
			localStorage: {
				getItem: (key: string) => entries.get(key) ?? null,
				setItem: (key: string, value: string) => {
					entries.set(key, value)
				},
			},
		})
		return entries
	}

	afterEach(() => {
		vi.unstubAllGlobals()
	})

	it("is neither returned nor left on disk", () => {
		const entries = stub()
		writeCommandHistory("abc123", ["/login hunter2", "/list"])

		expect(readCommandHistory("abc123")).toEqual(["/list"])
		expect([...entries.values()].join("\n")).not.toContain("hunter2")
	})

	it("leaves a history with nothing to purge untouched", () => {
		stub()
		writeCommandHistory("abc123", ["/say hi", "/list"])

		expect(readCommandHistory("abc123")).toEqual(["/say hi", "/list"])
	})
})
