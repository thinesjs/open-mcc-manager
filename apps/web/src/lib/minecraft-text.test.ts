import { describe, expect, it } from "vitest"
import {
	hasFormatting,
	MINECRAFT_COLORS,
	parseFormattedText,
	stripFormatting,
} from "./minecraft-text"

describe("minecraft text", () => {
	it("returns one unstyled span for plain text", () => {
		expect(parseFormattedText("hello")).toEqual([
			{
				start: 0,
				text: "hello",
				color: undefined,
				bold: false,
				italic: false,
				underlined: false,
				strikethrough: false,
				obfuscated: false,
			},
		])
	})

	it("splits a colour change into its own span", () => {
		const spans = parseFormattedText("§cdanger§r ok")

		expect(spans.map((span) => span.text)).toEqual(["danger", " ok"])
		expect(spans[0]?.color).toBe(MINECRAFT_COLORS.red)
		expect(spans[1]?.color).toBeUndefined()
	})

	it("keeps a style across following text until it is reset", () => {
		const spans = parseFormattedText("§lbold §ostill bold§r plain")

		expect(spans[0]?.bold).toBe(true)
		expect(spans[1]?.bold).toBe(true)
		expect(spans[1]?.italic).toBe(true)
		expect(spans[2]?.bold).toBe(false)
	})

	it("drops a style when a colour follows it, as the game does", () => {
		const spans = parseFormattedText("§lbold§cred")

		expect(spans[1]?.color).toBe(MINECRAFT_COLORS.red)
		expect(spans[1]?.bold).toBe(false)
	})

	it("reads a 1.16 hex colour written as its six escaped digits", () => {
		const spans = parseFormattedText("§x§f§f§0§0§8§8pink")

		expect(spans).toHaveLength(1)
		expect(spans[0]?.text).toBe("pink")
		expect(spans[0]?.color).toBe("#ff0088")
	})

	it("treats an incomplete hex escape as ordinary codes rather than losing the text", () => {
		expect(stripFormatting("§x§f§ftext")).toBe("text")
	})

	it("accepts an uppercase code", () => {
		expect(parseFormattedText("§Cred")[0]?.color).toBe(MINECRAFT_COLORS.red)
	})

	it("keeps a trailing lone section sign as text rather than dropping it", () => {
		expect(stripFormatting("done§")).toBe("done§")
	})

	it("ignores a code it does not know, keeping the text", () => {
		expect(stripFormatting("§zhello")).toBe("hello")
	})

	it("strips every code from a line", () => {
		expect(stripFormatting("§a§lGreen §r§7gray")).toBe("Green gray")
	})

	it("reports whether a line carries any formatting", () => {
		expect(hasFormatting("§ahi")).toBe(true)
		expect(hasFormatting("hi")).toBe(false)
	})

	it("produces no span for an empty string", () => {
		expect(parseFormattedText("")).toEqual([])
	})

	it("produces no empty spans when codes sit next to each other", () => {
		const spans = parseFormattedText("§a§l§ntext")

		expect(spans).toHaveLength(1)
		expect(spans[0]?.text).toBe("text")
	})

	it("gives each span the offset it began at, so a renderer has a stable key", () => {
		const spans = parseFormattedText("§cred§agreen")

		expect(spans.map((span) => span.start)).toEqual([2, 7])
		expect(new Set(spans.map((span) => span.start)).size).toBe(spans.length)
	})
})
