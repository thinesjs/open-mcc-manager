import { describe, expect, it } from "vitest"
import {
	completeName,
	PLAYER_SUGGESTION_LIMIT,
	PLAYER_TOKEN_MINIMUM,
	suggestPlayers,
} from "./player-completion"

const ONLINE = ["Steve", "Stone_Age", "Alex_99"]

const COMMAND_LENGTH_LIMIT = 256

describe("which names are offered", () => {
	it("offers the names the half-typed word starts", () => {
		expect(suggestPlayers(ONLINE, "/msg St")).toEqual(["Steve", "Stone_Age"])
	})

	it("ignores the case of what was typed", () => {
		expect(suggestPlayers(ONLINE, "hello ste")).toEqual(["Steve"])
	})

	it("matches only the start of a name, so a common middle does not pull in everyone", () => {
		expect(suggestPlayers(ONLINE, "one")).toEqual([])
	})

	it("says nothing until enough has been typed to mean something", () => {
		expect(suggestPlayers(ONLINE, "Steve".slice(0, PLAYER_TOKEN_MINIMUM - 1))).toEqual([])
		expect(suggestPlayers(ONLINE, "Steve".slice(0, PLAYER_TOKEN_MINIMUM))).toEqual([
			"Steve",
			"Stone_Age",
		])
	})

	it("says nothing when the word just ended, so ordinary chat is not interrupted", () => {
		expect(suggestPlayers(ONLINE, "St ")).toEqual([])
	})

	it("reads only the last word, not the whole line", () => {
		expect(suggestPlayers(ONLINE, "Steve said Al")).toEqual(["Alex_99"])
	})

	it("keeps one order between polls, whatever order the server listed them in", () => {
		expect(suggestPlayers(["Steve_C", "Steve_A", "Steve_B"], "Steve")).toEqual([
			"Steve_A",
			"Steve_B",
			"Steve_C",
		])
	})

	it("offers a repeated name once", () => {
		expect(suggestPlayers(["Steve", "Steve"], "St")).toEqual(["Steve"])
	})

	it("offers the lowest few rather than a crowded server", () => {
		const many = Array.from({ length: 20 }, (_, index) => `Steve_${19 - index}`)
		const offered = suggestPlayers(many, "Steve")

		expect(offered).toHaveLength(PLAYER_SUGGESTION_LIMIT)
		expect(offered).toContain("Steve_0")
	})
})

describe("a list the server should never have sent", () => {
	it.each([
		{ named: "a space", player: "not a name" },
		{ named: "a colour code", player: "§cSteve" },
		{ named: "more characters than a name can hold", player: "S".repeat(17) },
		{ named: "markup", player: "<img src=x>" },
	])("★ offers nothing at all when one entry carries $named", ({ player }) => {
		expect(suggestPlayers(["Steve", player], "St")).toEqual([])
	})

	it.each([
		{ named: "an address", player: "10.42.0.7" },
		{ named: "an address and a port", player: "10.42.0.7:25565" },
		{ named: "a hostname", player: "play.example.com" },
	])("★ never puts $named on the page, whatever is typed at it", ({ player }) => {
		expect(suggestPlayers(["Steve", player], "St")).toEqual([])
		expect(suggestPlayers(["Steve", player], "10")).toEqual([])
		expect(suggestPlayers(["Steve", player], "play")).toEqual([])
	})
})

describe("finishing the word", () => {
	it("replaces the half-typed name and leaves the rest of the line alone", () => {
		expect(completeName("/msg St", "Steve", COMMAND_LENGTH_LIMIT)).toBe("/msg Steve")
		expect(completeName("say hi to Al", "Alex_99", COMMAND_LENGTH_LIMIT)).toBe("say hi to Alex_99")
	})

	it("writes the name the way the server spells it, not the way it was typed", () => {
		expect(completeName("ste", "Steve", COMMAND_LENGTH_LIMIT)).toBe("Steve")
	})

	it.each([
		{ named: "chat", draft: "hello St" },
		{ named: "a server command", draft: "/msg St" },
		{ named: "a bot command", draft: "!follow St" },
	])("★ leaves $named as $named — it fills in a name, never a command", ({ draft }) => {
		const completed = completeName(draft, "Steve", COMMAND_LENGTH_LIMIT)

		expect(completed).toBe(`${draft.slice(0, draft.length - 2)}Steve`)
		expect(completed?.charAt(0)).toBe(draft.charAt(0))
	})

	it.each([
		{ named: "a space", name: "not a name" },
		{ named: "a slash", name: "/op" },
		{ named: "an address", name: "10.42.0.7" },
		{ named: "more characters than a name can hold", name: "S".repeat(17) },
	])("★ refuses a name carrying $named", ({ name }) => {
		expect(completeName("hello St", name, COMMAND_LENGTH_LIMIT)).toBeUndefined()
	})

	it("★ refuses when finishing the word would push past what the server accepts", () => {
		const filled = `${"x".repeat(COMMAND_LENGTH_LIMIT - 3)} St`

		expect(filled).toHaveLength(COMMAND_LENGTH_LIMIT)
		expect(completeName(filled, "Steve", COMMAND_LENGTH_LIMIT)).toBeUndefined()
		expect(completeName(filled, "Ab", COMMAND_LENGTH_LIMIT)).toBe(
			`${"x".repeat(COMMAND_LENGTH_LIMIT - 3)} Ab`,
		)
	})
})
