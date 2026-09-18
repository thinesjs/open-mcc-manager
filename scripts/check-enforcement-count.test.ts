import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { findProblems, numberFromWord } from "./check-enforcement-count.mjs"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

const CHECKER = join(ROOT, "scripts", "check-enforcement-count.mjs")

const HISTORICAL = join(ROOT, "scripts", "fixtures", "agents-1c9ac71.md")

const rows = (count: number): string[] =>
	Array.from({ length: count }, (_, index) => `| Rule ${index + 1} | a tool |`)

const document = (word: string, table: readonly string[]): string =>
	[
		"## What enforces what",
		"",
		"| Rule | Enforced by |",
		"| --- | --- |",
		"| A rule stated above | a tool |",
		"| Another rule stated above | a tool |",
		"",
		`${word} rules stated further down this document are enforced too, and are`,
		"listed here for the same reason — so that nothing claims enforcement it does not",
		"have:",
		"",
		"| Rule | Enforced by |",
		"| --- | --- |",
		...table,
		"",
		"Everything else in this document rests on review.",
		"",
	].join("\n")

const run = (path: string): { status: number | null; output: string } => {
	const result = spawnSync("node", [CHECKER, path], { cwd: ROOT, encoding: "utf8" })
	return { status: result.status, output: `${result.stdout}${result.stderr}` }
}

describe("reading the number the sentence spells", () => {
	it("reads the word the document uses today", () => {
		expect(numberFromWord("Thirty-seven")).toBe(37)
	})

	it("reads a plain ten, a hyphenated one and the top of the range", () => {
		expect([
			numberFromWord("twenty"),
			numberFromWord("forty-two"),
			numberFromWord("ninety-nine"),
		]).toEqual([20, 42, 99])
	})

	it("reads a count past forty, so the table may grow without the word list stopping short", () => {
		expect(findProblems(document("Forty-two", rows(42)))).toEqual([])
		expect(findProblems(document("Forty-two", rows(41)))).toHaveLength(1)
	})

	it("refuses a word it cannot read rather than passing the document", () => {
		const [problem] = findProblems(document("One-hundred-and-one", rows(101)))
		expect(problem).toContain("One-hundred-and-one")
		expect(problem).toContain("zero to ninety-nine")
	})

	it("refuses a count written as digits, which this sentence never uses", () => {
		expect(findProblems(document("38", rows(38)))).toHaveLength(1)
	})

	it("says so when the sentence is gone, rather than finding nothing to compare", () => {
		const [problem] = findProblems("## What enforces what\n\nNo table here.\n")
		expect(problem).toContain("no longer says how many rules")
	})
})

describe("counting the rows of the table that sentence introduces", () => {
	it("fails when a row is added and the count is left behind", () => {
		const [problem] = findProblems(document("Thirty-seven", rows(38)))
		expect(problem).toContain("says Thirty-seven (37)")
		expect(problem).toContain("has 38")
	})

	it("fails when the count is bumped and no row is added", () => {
		const [problem] = findProblems(document("Thirty-eight", rows(37)))
		expect(problem).toContain("says Thirty-eight (38)")
		expect(problem).toContain("has 37")
	})

	it("passes at a count that is not today's, so a hardcoded number would not do", () => {
		expect(findProblems(document("Three", rows(3)))).toEqual([])
		expect(findProblems(document("Thirty-eight", rows(38)))).toEqual([])
	})

	it("counts neither the header nor the separator as a row", () => {
		const [problem] = findProblems(document("Four", rows(2)))
		expect(problem).toContain("has 2")
	})

	it("counts the table below the sentence, not the two-row one above it", () => {
		expect(findProblems(document("One", rows(1)))).toEqual([])
	})

	it("refuses a row that wraps, because then a line count is not a row count", () => {
		const wrapped = ["| A rule | a tool described", "at some length |", "| Another | a tool |"]
		const [problem] = findProblems(document("Two", wrapped))
		expect(problem).toContain("not one whole row on one line")
	})

	it("refuses prose between the last row and the closing paragraph", () => {
		const [problem] = findProblems(document("One", ["| A rule | a tool |", "", "A loose note."]))
		expect(problem).toContain("counting lines would not count rows")
	})
})

describe("the document the gate guards", () => {
	it("agrees with its own stated count, so this lands green", () => {
		expect(findProblems(readFileSync(join(ROOT, "AGENTS.md"), "utf8"))).toEqual([])
	})

	it("rejects the merge that shipped thirty-six rows under a count of thirty-three", () => {
		const [problem] = findProblems(readFileSync(HISTORICAL, "utf8"), "AGENTS.md")
		expect(problem).toContain("says Thirty-three (33)")
		expect(problem).toContain("has 36")
	})
})

describe("the command pnpm lint runs", () => {
	it("exits 0 on the document as it stands", () => {
		expect(run(join(ROOT, "AGENTS.md")).status).toBe(0)
	})

	it("exits 1 and names the disagreement on the historical document", () => {
		const { status, output } = run(HISTORICAL)
		expect(status).toBe(1)
		expect(output).toContain("says Thirty-three (33) rules are enforced; the table below it has 36")
	})
})
