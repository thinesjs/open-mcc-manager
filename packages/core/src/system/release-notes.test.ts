import type { ReleaseNoteBlock, ReleaseNoteSpan } from "@open-mcc/contracts"
import { describe, expect, it } from "vitest"
import {
	parseInline,
	parseReleaseNotes,
	RELEASE_NOTE_MAX_BLOCK_CHARS,
	RELEASE_NOTE_MAX_BLOCKS,
} from "./release-notes"

const blocksOf = (source: string): ReleaseNoteBlock[] => parseReleaseNotes(source).blocks

const text = (value: string, start = 0): ReleaseNoteSpan => ({ kind: "text", start, text: value })

const shownText = (spans: readonly ReleaseNoteSpan[]): string =>
	spans.map((span) => (span.kind === "link" ? `[${span.label}](${span.url})` : span.text)).join("")

const LINEAR_BUDGET_MS = 500

const KIB_64 = 64 * 1024

const timed = (source: string): number => {
	const started = performance.now()
	parseReleaseNotes(source)
	return performance.now() - started
}

describe("the blocks a release note is read into", () => {
	it("reads a heading, with or without closing marks", () => {
		expect(blocksOf("## Fixes\n### Features ###")).toEqual([
			{ kind: "heading", start: 0, spans: [text("Fixes")] },
			{ kind: "heading", start: 9, spans: [text("Features")] },
		])
	})

	it("keeps closing hashes that are not set apart by a space as part of the heading", () => {
		expect(blocksOf("## C#")).toEqual([{ kind: "heading", start: 0, spans: [text("C#")] }])
	})

	it("reads a heading of closing marks alone as ordinary text", () => {
		expect(blocksOf("## ##")).toEqual([{ kind: "paragraph", start: 0, spans: [text("## ##")] }])
	})

	it("reads a hash with no space after it as ordinary text", () => {
		const hashtag = { kind: "paragraph", start: 0, spans: [text("#hashtag")] }
		expect(blocksOf("#hashtag")).toEqual([hashtag])
	})

	it("joins neighbouring lines into one paragraph and splits paragraphs on a blank line", () => {
		expect(blocksOf("first line\nsecond line\n\nnext paragraph")).toEqual([
			{ kind: "paragraph", start: 0, spans: [text("first line\nsecond line")] },
			{ kind: "paragraph", start: 24, spans: [text("next paragraph")] },
		])
	})

	it("reads each bullet marker as a list item", () => {
		expect(blocksOf("- one\n* two\n+ three")).toEqual([
			{ kind: "bullet", start: 0, spans: [text("one")] },
			{ kind: "bullet", start: 6, spans: [text("two")] },
			{ kind: "bullet", start: 12, spans: [text("three")] },
		])
	})

	it("reads a numbered item and keeps the number its author wrote", () => {
		expect(blocksOf("1. one\n7) seven")).toEqual([
			{ kind: "numbered", start: 0, number: "1", spans: [text("one")] },
			{ kind: "numbered", start: 7, number: "7", spans: [text("seven")] },
		])
	})

	it("reads a fenced code block verbatim, formatting marks included", () => {
		expect(blocksOf("```ts\nconst a = **b**\n  <b>c</b>\n```\nafter")).toEqual([
			{ kind: "code", start: 0, text: "const a = **b**\n  <b>c</b>" },
			{ kind: "paragraph", start: 37, spans: [text("after")] },
		])
	})

	it("closes a fence only with the same mark at least as long", () => {
		expect(blocksOf("~~~~\n```\n~~~\n~~~~")).toEqual([{ kind: "code", start: 0, text: "```\n~~~" }])
	})

	it("closes a code block left open at the end, so a cut-short note keeps its last block", () => {
		expect(blocksOf("intro\n\n```\nnpm install\nnpm run migrate")).toEqual([
			{ kind: "paragraph", start: 0, spans: [text("intro")] },
			{ kind: "code", start: 7, text: "npm install\nnpm run migrate" },
		])
	})

	it("reads lines indented by four spaces as code", () => {
		const code = "docker compose pull\ndocker compose up -d"
		expect(blocksOf("    docker compose pull\n    docker compose up -d\n\ndone")).toEqual([
			{ kind: "code", start: 0, text: code },
			{ kind: "paragraph", start: 50, spans: [text("done")] },
		])
	})

	it("keeps an indented line that continues a paragraph in that paragraph", () => {
		const source = "a paragraph\n    still the paragraph"
		expect(blocksOf(source)).toEqual([{ kind: "paragraph", start: 0, spans: [text(source)] }])
	})

	it("reads Windows line endings the same way", () => {
		expect(blocksOf("## Fixes\r\n- one\r\n")).toEqual([
			{ kind: "heading", start: 0, spans: [text("Fixes")] },
			{ kind: "bullet", start: 9, spans: [text("one")] },
		])
	})

	it("reads an empty note as no blocks", () => {
		expect(parseReleaseNotes("  \n\n")).toEqual({ blocks: [], capped: false })
	})
})

describe("the offsets the page keys each block and span on", () => {
	const NOTE = "## Fixes\n- **one** and `two`\n\n```\ncode\n```\nlast [a](b) line"

	it("gives every block an offset no other block in the note shares", () => {
		const starts = blocksOf(NOTE).map((block) => block.start)

		expect(starts).toEqual([0, 9, 30, 43])
	})

	it("gives every span an offset no other span in its block shares", () => {
		const spansOf = (block: ReleaseNoteBlock | undefined) =>
			block !== undefined && block.kind !== "code" ? block.spans : []
		const [, bullet, , last] = blocksOf(NOTE)

		expect(spansOf(bullet).map((span) => span.start)).toEqual([0, 7, 12])
		expect(spansOf(last).map((span) => span.start)).toEqual([0, 5, 11])
	})
})

describe("what a release note may not become", () => {
	it("keeps <script>alert(1)</script> as the characters it is written with, never as markup", () => {
		const script = "<script>alert(1)</script>"
		expect(blocksOf(script)).toEqual([{ kind: "paragraph", start: 0, spans: [text(script)] }])
	})

	it("carries a link's address only as text to show, never as something to follow", () => {
		const link = { kind: "link", start: 4, label: "the docs", url: "https://example.com/a" }
		expect(parseInline("see [the docs](https://example.com/a) now")).toEqual([
			text("see "),
			link,
			text(" now", 37),
		])
	})

	it("reads an image as literal text rather than as a link with a bang in front", () => {
		expect(parseInline("![logo](https://example.com/logo.png)")).toEqual([
			text("![logo](https://example.com/logo.png)"),
		])
	})

	it("keeps an image, a table, a quote, a nested list, a footnote, an autolink and a tag as literal text", () => {
		const unsupported = [
			"![logo](https://example.com/logo.png)",
			"| a | b |",
			"> quoted",
			"  - nested",
			"[^1]: a footnote",
			"<https://example.com>",
			"<img src=x onerror=alert(1)>",
		]
		for (const line of unsupported) {
			const [block] = blocksOf(line)
			expect(block?.kind, line).toBe("paragraph")
			expect(block?.kind === "paragraph" && shownText(block.spans), line).toBe(line)
		}
	})
})

describe("inline formatting", () => {
	it("reads bold, italic and inline code", () => {
		expect(parseInline("**bold** and *italic* and _also_ and `code`")).toEqual([
			{ kind: "bold", start: 0, text: "bold" },
			text(" and ", 8),
			{ kind: "italic", start: 13, text: "italic" },
			text(" and ", 21),
			{ kind: "italic", start: 26, text: "also" },
			text(" and ", 32),
			{ kind: "code", start: 37, text: "code" },
		])
	})

	it("leaves an underscore that would open emphasis inside a word alone", () => {
		expect(parseInline("rename config_v2_ to config_v3")).toEqual([
			text("rename config_v2_ to config_v3"),
		])
	})

	it("leaves an underscore that would close emphasis inside a word alone", () => {
		expect(parseInline("_internal_name stays as written")).toEqual([
			text("_internal_name stays as written"),
		])
	})

	it("leaves an asterisk with space around it alone", () => {
		expect(parseInline("2 * 3 * 4")).toEqual([text("2 * 3 * 4")])
	})

	it("keeps an unclosed mark as the character it is", () => {
		expect(parseInline("**never closed and `open")).toEqual([text("**never closed and `open")])
	})

	it("reads code containing backticks when fenced by a longer run", () => {
		expect(parseInline("``a ` b``")).toEqual([{ kind: "code", start: 0, text: "a ` b" }])
	})

	it("reads a backslash-escaped mark as the mark itself", () => {
		expect(parseInline("\\*not italic\\*")).toEqual([text("*not italic*")])
	})
})

describe("the bound that keeps a long note from freezing the browser", () => {
	const items = (count: number): string =>
		Array.from({ length: count }, (_, n) => `- item ${n}`).join("\n")

	it("stops at five hundred blocks and says it did", () => {
		const parsed = parseReleaseNotes(items(RELEASE_NOTE_MAX_BLOCKS + 100))

		expect(parsed.blocks).toHaveLength(RELEASE_NOTE_MAX_BLOCKS)
		expect(parsed.capped).toBe(true)
	})

	it("keeps exactly five hundred blocks without saying anything was cut", () => {
		const parsed = parseReleaseNotes(items(RELEASE_NOTE_MAX_BLOCKS))

		expect(parsed.blocks).toHaveLength(RELEASE_NOTE_MAX_BLOCKS)
		expect(parsed.capped).toBe(false)
	})

	it("cuts a block past two thousand characters and says it did", () => {
		const parsed = parseReleaseNotes("x".repeat(RELEASE_NOTE_MAX_BLOCK_CHARS + 50))
		const [block] = parsed.blocks
		const shown = block?.kind === "paragraph" ? shownText(block.spans) : ""

		expect(parsed.capped).toBe(true)
		expect(Array.from(shown)).toHaveLength(RELEASE_NOTE_MAX_BLOCK_CHARS)
	})

	it("cuts a code block past two thousand characters too", () => {
		const long = "y".repeat(RELEASE_NOTE_MAX_BLOCK_CHARS + 50)
		const parsed = parseReleaseNotes(`\`\`\`\n${long}\n\`\`\``)
		const [block] = parsed.blocks
		const shown = block?.kind === "code" ? block.text : ""

		expect(parsed.capped).toBe(true)
		expect(Array.from(shown)).toHaveLength(RELEASE_NOTE_MAX_BLOCK_CHARS)
	})

	it("keeps a block of exactly two thousand characters whole", () => {
		const exact = "z".repeat(RELEASE_NOTE_MAX_BLOCK_CHARS)

		expect(parseReleaseNotes(exact)).toEqual({
			blocks: [{ kind: "paragraph", start: 0, spans: [text(exact)] }],
			capped: false,
		})
	})

	it("holds the bounds at five hundred blocks and two thousand characters", () => {
		expect(RELEASE_NOTE_MAX_BLOCKS).toBe(500)
		expect(RELEASE_NOTE_MAX_BLOCK_CHARS).toBe(2000)
	})
})

describe("the time one stored note can cost the server", () => {
	const SEPARATOR = String.fromCharCode(0x2028)

	it("reads a 64 KiB heading-shaped line without backtracking over it", () => {
		expect(timed(`# a${" ".repeat(KIB_64 - 4)}b`)).toBeLessThan(LINEAR_BUDGET_MS)
	})

	it("reads a 64 KiB heading line broken by a line separator without backtracking over it", () => {
		expect(timed(`#${" ".repeat(KIB_64 - 4)}${SEPARATOR}x`)).toBeLessThan(LINEAR_BUDGET_MS)
	})

	it("reads a 64 KiB bullet line broken by a line separator without backtracking over it", () => {
		expect(timed(`-${" ".repeat(KIB_64 - 4)}${SEPARATOR}x`)).toBeLessThan(LINEAR_BUDGET_MS)
	})

	it("reads a 64 KiB numbered line broken by a line separator without backtracking over it", () => {
		expect(timed(`1.${" ".repeat(KIB_64 - 5)}${SEPARATOR}x`)).toBeLessThan(LINEAR_BUDGET_MS)
	})

	it("keeps a line separator inside a list item as part of that item", () => {
		const item = `one${SEPARATOR}two`
		expect(blocksOf(`- ${item}`)).toEqual([{ kind: "bullet", start: 0, spans: [text(item)] }])
	})
})
