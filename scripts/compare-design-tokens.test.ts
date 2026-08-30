import { describe, expect, it } from "vitest"
import {
	compareTokens,
	formatReport,
	parseDeclarations,
	stripComments,
} from "./compare-the reference-tokens.mjs"

describe("parseDeclarations", () => {
	it("parses a declaration that has a comment above it, so documenting a token cannot hide it from the comparison", () => {
		const css = [
			":root {",
			"\t--alpha: 1px;",
			"\t/* Keep this in the same family as the sidebar. */",
			"\t--beta: 2px;",
			"\t--gamma: 3px;",
			"}",
		].join("\n")

		expect(parseDeclarations(css).map((declaration) => declaration.name)).toEqual([
			"--alpha",
			"--beta",
			"--gamma",
		])
	})

	it("parses a declaration whose comment spans several lines", () => {
		const css = ":root {\n\t/* one\n\t   two */\n\t--alpha: 1px;\n}"

		expect(parseDeclarations(css)).toEqual([{ scope: ":root", name: "--alpha", value: "1px" }])
	})

	it("keeps a comment before a block out of the scope it opens", () => {
		const css = "/* tokens the dashboard reads */\n:root {\n\t--alpha: 1px;\n}"

		expect(parseDeclarations(css)).toEqual([{ scope: ":root", name: "--alpha", value: "1px" }])
	})

	it("keeps the same property in two scopes as two declarations, so a light value cannot satisfy a dark one", () => {
		const css =
			":root {\n\t--background: white;\n\t@variant dark {\n\t\t--background: black;\n\t}\n}"

		expect(parseDeclarations(css)).toEqual([
			{ scope: ":root", name: "--background", value: "white" },
			{ scope: ":root > @variant dark", name: "--background", value: "black" },
		])
	})

	it("collapses whitespace so a value wrapped across lines matches the same value on one line", () => {
		const wrapped =
			":root {\n\t--surface: color-mix(\n\t\tin srgb,\n\t\twhite 40%,\n\t\tblack\n\t);\n}"
		const inline = ":root {\n\t--surface: color-mix( in srgb, white 40%, black );\n}"

		expect(parseDeclarations(wrapped)).toEqual(parseDeclarations(inline))
	})

	it("ignores an ordinary property so only custom properties are compared", () => {
		expect(parseDeclarations(":root {\n\tcolor-scheme: dark;\n\t--alpha: 1px;\n}")).toEqual([
			{ scope: ":root", name: "--alpha", value: "1px" },
		])
	})
})

describe("stripComments", () => {
	it("leaves a stylesheet with no comments untouched", () => {
		const css = ":root {\n\t--alpha: 1px;\n}"

		expect(stripComments(css)).toBe(css)
	})
})

describe("compareTokens", () => {
	const ours = parseDeclarations(":root {\n\t--same: 1px;\n\t--moved: 2px;\n\t--only-ours: 3px;\n}")
	const reference = parseDeclarations(":root {\n\t--same: 1px;\n\t--moved: 9px;\n}")

	it("counts a matching scope, name and value as identical", () => {
		expect(compareTokens(ours, reference).identical).toEqual([
			{ scope: ":root", name: "--same", value: "1px" },
		])
	})

	it("reports a value that differs from the reference rather than counting it as a match", () => {
		expect(compareTokens(ours, reference).differing).toEqual([
			{ scope: ":root", name: "--moved", value: "2px", reference: "9px" },
		])
	})

	it("treats a declaration absent from the reference as absent rather than as identical", () => {
		expect(compareTokens(ours, reference).unmatched).toEqual([
			{ scope: ":root", name: "--only-ours", value: "3px" },
		])
	})

	it("treats a declaration the reference puts in another scope as absent, not as a match", () => {
		const dark = parseDeclarations(":root {\n\t@variant dark {\n\t\t--same: 1px;\n\t}\n}")

		expect(compareTokens(parseDeclarations(":root {\n\t--same: 1px;\n}"), dark).unmatched).toEqual([
			{ scope: ":root", name: "--same", value: "1px" },
		])
	})
})

describe("formatReport", () => {
	it("names the reference commit and date, so a pasted result carries its own provenance", () => {
		const report = formatReport(
			{ checkoutPath: "/checkouts/the reference", commit: "fdd1572b6", date: "2026-08-22" },
			{ compared: 1, identical: [], differing: [], unmatched: [] },
		)

		expect(report).toContain("fdd1572b6")
		expect(report).toContain("2026-08-22")
		expect(report).toContain("/checkouts/the reference")
	})
})
