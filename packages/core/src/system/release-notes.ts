import type { ReleaseNoteBlock, ReleaseNoteSpan } from "@open-mcc/contracts"
import { truncateChars } from "../notification/bounds"

export const RELEASE_NOTE_MAX_BLOCKS = 500

export const RELEASE_NOTE_MAX_BLOCK_CHARS = 2000

export type ParsedReleaseNotes = {
	readonly blocks: ReleaseNoteBlock[]
	readonly capped: boolean
}

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/

const INDENTED = /^(?: {4}|\t)/

const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*)$/s

const BULLET = /^[-*+][ \t]+(.*)$/s

const NUMBERED = /^(\d{1,9})[.)][ \t]+(.*)$/s

const LINK = /\[([^[\]\n]*)\]\(([^()\s]*)\)/y

const IMAGE = /!\[[^[\]\n]*\]\([^()\s]*\)/y

const ESCAPABLE = /^[!-/:-@[-`{-~]$/

const WORD = /^[\p{L}\p{N}]$/u

const isBlank = (line: string): boolean => line.trim().length === 0

const trimSpaceEnd = (value: string): string => {
	let end = value.length
	while (end > 0 && (value[end - 1] === " " || value[end - 1] === "\t")) end -= 1
	return value.slice(0, end)
}

const headingTextOf = (raw: string): string => {
	const text = trimSpaceEnd(raw)
	let end = text.length
	while (end > 0 && text[end - 1] === "#") end -= 1
	if (end === text.length) return text
	if (end === 0) return ""
	const before = text[end - 1]
	if (before !== " " && before !== "\t") return text
	return trimSpaceEnd(text.slice(0, end))
}

const closesFence = (line: string, mark: string): boolean => {
	const char = mark.charAt(0)
	const trimmed = line.replace(/^ {0,3}/, "").trimEnd()
	if (trimmed.length < mark.length) return false
	return Array.from(trimmed).every((each) => each === char)
}

const isWord = (char: string | undefined): boolean => char !== undefined && WORD.test(char)

const isSpace = (char: string | undefined): boolean => char === undefined || /\s/.test(char)

const findEmphasisClose = (source: string, mark: string, from: number): number => {
	const char = mark.charAt(0)
	for (let at = source.indexOf(mark, from); at !== -1; at = source.indexOf(mark, at + 1)) {
		if (isSpace(source[at - 1])) continue
		if (mark.length === 1 && (source[at - 1] === char || source[at + 1] === char)) continue
		if (char === "_" && isWord(source[at + mark.length])) continue
		return at
	}
	return -1
}

const backtickRunAt = (source: string, at: number): number => {
	let end = at
	while (source[end] === "`") end += 1
	return end - at
}

const findBacktickClose = (source: string, from: number, length: number): number => {
	for (let at = source.indexOf("`", from); at !== -1; ) {
		const run = backtickRunAt(source, at)
		if (run === length) return at
		at = source.indexOf("`", at + run)
	}
	return -1
}

const matchAt = (pattern: RegExp, source: string, at: number): RegExpExecArray | null => {
	pattern.lastIndex = at
	return pattern.exec(source)
}

export const parseInline = (source: string): ReleaseNoteSpan[] => {
	const spans: ReleaseNoteSpan[] = []
	let plain = ""
	let plainStart = 0
	const addPlain = (value: string, at: number) => {
		if (plain.length === 0) plainStart = at
		plain += value
	}
	const flush = () => {
		if (plain.length > 0) spans.push({ kind: "text", start: plainStart, text: plain })
		plain = ""
	}

	let at = 0
	while (at < source.length) {
		const char = source.charAt(at)
		const next = source.charAt(at + 1)

		if (char === "\\" && ESCAPABLE.test(next)) {
			addPlain(next, at)
			at += 2
			continue
		}

		if (char === "`") {
			const run = backtickRunAt(source, at)
			const close = findBacktickClose(source, at + run, run)
			if (close === -1) {
				addPlain("`".repeat(run), at)
				at += run
				continue
			}
			const inner = source.slice(at + run, close)
			const padded = inner.length > 2 && inner.startsWith(" ") && inner.endsWith(" ")
			flush()
			spans.push({ kind: "code", start: at, text: padded ? inner.slice(1, -1) : inner })
			at = close + run
			continue
		}

		if (char === "!") {
			const image = matchAt(IMAGE, source, at)
			if (image !== null) {
				addPlain(image[0], at)
				at += image[0].length
				continue
			}
		}

		if (char === "[") {
			const link = matchAt(LINK, source, at)
			if (link !== null) {
				flush()
				spans.push({ kind: "link", start: at, label: link[1] ?? "", url: link[2] ?? "" })
				at += link[0].length
				continue
			}
		}

		if (char === "*" || char === "_") {
			const mark = next === char ? `${char}${char}` : char
			const start = at + mark.length
			const opens = !isSpace(source[start]) && !(char === "_" && isWord(source[at - 1]))
			const close = opens ? findEmphasisClose(source, mark, start + 1) : -1
			if (close === -1) {
				addPlain(mark, at)
				at = start
				continue
			}
			flush()
			const kind = mark.length === 2 ? "bold" : "italic"
			spans.push({ kind, start: at, text: source.slice(start, close) })
			at = close + mark.length
			continue
		}

		addPlain(char, at)
		at += 1
	}
	flush()
	return spans
}

export const parseReleaseNotes = (source: string): ParsedReleaseNotes => {
	const lines = source.replace(/\r\n?/g, "\n").split("\n")
	const lineStarts: number[] = []
	let offset = 0
	for (const line of lines) {
		lineStarts.push(offset)
		offset += line.length + 1
	}
	const startOf = (index: number): number => lineStarts[index] ?? offset

	const blocks: ReleaseNoteBlock[] = []
	let capped = false
	let paragraph: string[] = []
	let paragraphStart = 0

	const bounded = (text: string): string => {
		const kept = truncateChars(text, RELEASE_NOTE_MAX_BLOCK_CHARS)
		if (kept !== text) capped = true
		return kept
	}

	const push = (block: ReleaseNoteBlock) => {
		if (blocks.length >= RELEASE_NOTE_MAX_BLOCKS) {
			capped = true
			return
		}
		blocks.push(block)
	}

	const flushParagraph = () => {
		if (paragraph.length === 0) return
		const spans = parseInline(bounded(paragraph.join("\n")))
		push({ kind: "paragraph", start: paragraphStart, spans })
		paragraph = []
	}

	let index = 0
	while (index < lines.length) {
		const line = lines[index] ?? ""
		const lineStart = startOf(index)

		const fence = FENCE_OPEN.exec(line)
		if (fence !== null) {
			flushParagraph()
			const mark = fence[1] ?? "```"
			const body: string[] = []
			index += 1
			while (index < lines.length && !closesFence(lines[index] ?? "", mark)) {
				body.push(lines[index] ?? "")
				index += 1
			}
			index += 1
			push({ kind: "code", start: lineStart, text: bounded(body.join("\n")) })
			continue
		}

		if (isBlank(line)) {
			flushParagraph()
			index += 1
			continue
		}

		if (paragraph.length === 0 && INDENTED.test(line)) {
			const body: string[] = []
			while (index < lines.length) {
				const current = lines[index] ?? ""
				if (!INDENTED.test(current) && !isBlank(current)) break
				body.push(current.replace(INDENTED, ""))
				index += 1
			}
			while (body.length > 0 && isBlank(body[body.length - 1] ?? "")) body.pop()
			push({ kind: "code", start: lineStart, text: bounded(body.join("\n")) })
			continue
		}

		const heading = HEADING.exec(line)
		const headingText = heading === null ? "" : headingTextOf(heading[2] ?? "")
		if (headingText.length > 0) {
			flushParagraph()
			push({ kind: "heading", start: lineStart, spans: parseInline(bounded(headingText)) })
			index += 1
			continue
		}

		const bullet = BULLET.exec(line)
		if (bullet !== null) {
			flushParagraph()
			push({ kind: "bullet", start: lineStart, spans: parseInline(bounded(bullet[1] ?? "")) })
			index += 1
			continue
		}

		const numbered = NUMBERED.exec(line)
		if (numbered !== null) {
			flushParagraph()
			const spans = parseInline(bounded(numbered[2] ?? ""))
			push({ kind: "numbered", start: lineStart, number: numbered[1] ?? "", spans })
			index += 1
			continue
		}

		if (paragraph.length === 0) paragraphStart = lineStart
		paragraph.push(line)
		index += 1
	}
	flushParagraph()
	return { blocks, capped }
}
