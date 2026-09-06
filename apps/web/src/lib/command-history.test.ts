import { describe, expect, it } from "vitest"
import { COMMAND_HISTORY_LIMIT, rememberCommand } from "./command-history"

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
