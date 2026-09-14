import type { ReleaseNoteBlock, ReleaseNoteSpan } from "@open-mcc/contracts"
import { describe, expect, it } from "vitest"
import {
	parseInline,
	parseReleaseNotes,
	RELEASE_NOTE_MAX_BLOCK_CHARS,
	RELEASE_NOTE_MAX_BLOCKS,
} from "./release-notes"

const blocksOf = (source: string): ReleaseNoteBlock[] => parseReleaseNotes(source).blocks

const text = (value: string): ReleaseNoteSpan => ({ kind: "text", text: value })

const shownText = (spans: readonly ReleaseNoteSpan[]): string =>
	spans.map((span) => (span.kind === "link" ? `[${span.label}](${span.url})` : span.text)).join("")

describe("the blocks a release note is read into", () => {
	it("reads a heading, with or without closing marks", () => {
		expect(blocksOf("## Fixes\n### Features ###")).toEqual([
			{ kind: "heading", spans: [text("Fixes")] },
			{ kind: "heading", spans: [text("Features")] },
		])
	})

	it("reads a hash with no space after it as ordinary text", () => {
		expect(blocksOf("#hashtag")).toEqual([{ kind: "paragraph", spans: [text("#hashtag")] }])
	})

	it("joins neighbouring lines into one paragraph and splits paragraphs on a blank line", () => {
		expect(blocksOf("first line\nsecond line\n\nnext paragraph")).toEqual([
			{ kind: "paragraph", spans: [text("first line\nsecond line")] },
			{ kind: "paragraph", spans: [text("next paragraph")] },
		])
	})

	it("reads each bullet marker as a list item", () => {
		expect(blocksOf("- one\n* two\n+ three")).toEqual([
			{ kind: "bullet", spans: [text("one")] },
			{ kind: "bullet", spans: [text("two")] },
			{ kind: "bullet", spans: [text("three")] },
		])
	})

	it("reads a numbered item and keeps the number its author wrote", () => {
		expect(blocksOf("1. one\n7) seven")).toEqual([
			{ kind: "numbered", number: "1", spans: [text("one")] },
			{ kind: "numbered", number: "7", spans: [text("seven")] },
		])
	})

	it("reads a fenced code block verbatim, formatting marks included", () => {
		expect(blocksOf("```ts\nconst a = **b**\n  <b>c</b>\n```\nafter")).toEqual([
			{ kind: "code", text: "const a = **b**\n  <b>c</b>" },
			{ kind: "paragraph", spans: [text("after")] },
		])
	})

	it("closes a fence only with the same mark at least as long", () => {
		expect(blocksOf("~~~~\n```\n~~~\n~~~~")).toEqual([{ kind: "code", text: "```\n~~~" }])
	})

	it("closes a code block left open at the end, so a cut-short note keeps its last block", () => {
		expect(blocksOf("intro\n\n```\nnpm install\nnpm run migrate")).toEqual([
			{ kind: "paragraph", spans: [text("intro")] },
			{ kind: "code", text: "npm install\nnpm run migrate" },
		])
	})

	it("reads lines indented by four spaces as code", () => {
		expect(blocksOf("    docker compose pull\n    docker compose up -d\n\ndone")).toEqual([
			{ kind: "code", text: "docker compose pull\ndocker compose up -d" },
			{ kind: "paragraph", spans: [text("done")] },
		])
	})

	it("keeps an indented line that continues a paragraph in that paragraph", () => {
		expect(blocksOf("a paragraph\n    still the paragraph")).toEqual([
			{ kind: "paragraph", spans: [text("a paragraph\n    still the paragraph")] },
		])
	})

	it("reads Windows line endings the same way", () => {
		expect(blocksOf("## Fixes\r\n- one\r\n")).toEqual([
			{ kind: "heading", spans: [text("Fixes")] },
			{ kind: "bullet", spans: [text("one")] },
		])
	})

	it("reads an empty note as no blocks", () => {
		expect(parseReleaseNotes("  \n\n")).toEqual({ blocks: [], capped: false })
	})
})

describe("what a release note may not become", () => {
	it("keeps <script>alert(1)</script> as the characters it is written with, never as markup", () => {
		expect(blocksOf("<script>alert(1)</script>")).toEqual([
			{ kind: "paragraph", spans: [text("<script>alert(1)</script>")] },
		])
	})

	it("carries a link's address only as text to show, never as something to follow", () => {
		expect(parseInline("see [the docs](https://example.com/a) now")).toEqual([
			text("see "),
			{ kind: "link", label: "the docs", url: "https://example.com/a" },
			text(" now"),
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
			{ kind: "bold", text: "bold" },
			text(" and "),
			{ kind: "italic", text: "italic" },
			text(" and "),
			{ kind: "italic", text: "also" },
			text(" and "),
			{ kind: "code", text: "code" },
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
		expect(parseInline("``a ` b``")).toEqual([{ kind: "code", text: "a ` b" }])
	})

	it("reads a backslash-escaped mark as the mark itself", () => {
		expect(parseInline("\\*not italic\\*")).toEqual([text("*not italic*")])
	})
})

describe("the bound that keeps a long note from freezing the browser", () => {
	it("stops at five hundred blocks and says it did", () => {
		const note = Array.from(
			{ length: RELEASE_NOTE_MAX_BLOCKS + 100 },
			(_, n) => `- item ${n}`,
		).join("\n")
		const parsed = parseReleaseNotes(note)

		expect(parsed.blocks).toHaveLength(RELEASE_NOTE_MAX_BLOCKS)
		expect(parsed.capped).toBe(true)
	})

	it("keeps exactly five hundred blocks without saying anything was cut", () => {
		const note = Array.from({ length: RELEASE_NOTE_MAX_BLOCKS }, (_, n) => `- item ${n}`).join("\n")
		const parsed = parseReleaseNotes(note)

		expect(parsed.blocks).toHaveLength(RELEASE_NOTE_MAX_BLOCKS)
		expect(parsed.capped).toBe(false)
	})

	it("cuts a block past two thousand characters and says it did", () => {
		const parsed = parseReleaseNotes("x".repeat(RELEASE_NOTE_MAX_BLOCK_CHARS + 50))
		const [block] = parsed.blocks

		expect(parsed.capped).toBe(true)
		expect(Array.from(block?.kind === "paragraph" ? shownText(block.spans) : "")).toHaveLength(
			RELEASE_NOTE_MAX_BLOCK_CHARS,
		)
	})

	it("cuts a code block past two thousand characters too", () => {
		const parsed = parseReleaseNotes(
			`\`\`\`\n${"y".repeat(RELEASE_NOTE_MAX_BLOCK_CHARS + 50)}\n\`\`\``,
		)
		const [block] = parsed.blocks

		expect(parsed.capped).toBe(true)
		expect(Array.from(block?.kind === "code" ? block.text : "")).toHaveLength(
			RELEASE_NOTE_MAX_BLOCK_CHARS,
		)
	})

	it("keeps a block of exactly two thousand characters whole", () => {
		const exact = "z".repeat(RELEASE_NOTE_MAX_BLOCK_CHARS)

		expect(parseReleaseNotes(exact)).toEqual({
			blocks: [{ kind: "paragraph", spans: [text(exact)] }],
			capped: false,
		})
	})

	it("holds the bounds at five hundred blocks and two thousand characters", () => {
		expect(RELEASE_NOTE_MAX_BLOCKS).toBe(500)
		expect(RELEASE_NOTE_MAX_BLOCK_CHARS).toBe(2000)
	})
})
