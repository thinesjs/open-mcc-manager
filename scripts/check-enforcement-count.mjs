import { readFileSync } from "node:fs"
import { join } from "node:path"

const DOCUMENT = join(import.meta.dirname, "..", "AGENTS.md")

const DEFAULT_LABEL = "AGENTS.md"

const UNITS = [
	"zero",
	"one",
	"two",
	"three",
	"four",
	"five",
	"six",
	"seven",
	"eight",
	"nine",
	"ten",
	"eleven",
	"twelve",
	"thirteen",
	"fourteen",
	"fifteen",
	"sixteen",
	"seventeen",
	"eighteen",
	"nineteen",
]

const TENS = ["twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"]

const buildNumberWords = () => {
	const found = new Map(UNITS.map((word, value) => [word, value]))
	for (const [index, ten] of TENS.entries()) {
		const base = (index + 2) * 10
		found.set(ten, base)
		for (let unit = 1; unit <= 9; unit += 1) found.set(`${ten}-${UNITS[unit]}`, base + unit)
	}
	return found
}

export const NUMBER_WORDS = buildNumberWords()

export const SUPPORTED_RANGE = "zero to ninety-nine"

export const numberFromWord = (word) => NUMBER_WORDS.get(word.toLowerCase())

const SENTENCE = /^(\S+) rules stated further down this document are enforced too\b/

const HEADER = "| Rule | Enforced by |"

const SEPARATOR = "| --- | --- |"

const TABLE_END = "Everything else in this document"

export const findSentence = (lines) => {
	for (const [index, line] of lines.entries()) {
		const match = SENTENCE.exec(line)
		if (match !== null) return { index, word: match[1] ?? "" }
	}
	return undefined
}

export const findProblems = (document, label = DEFAULT_LABEL) => {
	const lines = document.split("\n")

	const sentence = findSentence(lines)
	if (sentence === undefined) {
		return [
			`${label} no longer says how many rules the enforced-rules table holds, so nothing ties a count to that table`,
		]
	}

	const at = `${label}:${sentence.index + 1}`
	const stated = numberFromWord(sentence.word)
	if (stated === undefined) {
		return [
			`${at} cannot read "${sentence.word}" as a number; spell the count as an English word from ${SUPPORTED_RANGE}`,
		]
	}

	const header = lines.indexOf(HEADER, sentence.index)
	if (header === -1) return [`${at} states a count, but no "${HEADER}" table follows it`]
	if (lines[header + 1] !== SEPARATOR) {
		return [`${label}:${header + 2} the table under the stated count lacks its "${SEPARATOR}" line`]
	}

	let end = -1
	for (let index = header + 2; index < lines.length; index += 1) {
		if ((lines[index] ?? "").startsWith(TABLE_END)) {
			end = index
			break
		}
	}
	if (end === -1) {
		return [
			`${label}:${header + 1} the table under the stated count never reaches the paragraph beginning "${TABLE_END}", so its rows cannot be counted`,
		]
	}

	let rows = 0
	let index = header + 2
	while (index < end && (lines[index] ?? "").startsWith("|")) {
		if (!(lines[index] ?? "").trimEnd().endsWith("|")) {
			return [
				`${label}:${index + 1} this row does not end at "|", so it is not one whole row on one line`,
			]
		}
		rows += 1
		index += 1
	}

	for (let rest = index; rest < end; rest += 1) {
		if ((lines[rest] ?? "").trim() === "") continue
		return [
			`${label}:${rest + 1} this line sits between the last row and "${TABLE_END}" without being a row, so counting lines would not count rows`,
		]
	}

	if (rows !== stated) {
		return [
			`${at} says ${sentence.word} (${stated}) rules are enforced; the table below it has ${rows}`,
		]
	}

	return []
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const given = process.argv[2]
	const found = findProblems(readFileSync(given ?? DOCUMENT, "utf8"), given ?? DEFAULT_LABEL)
	for (const problem of found) console.error(problem)
	process.exit(found.length === 0 ? 0 : 1)
}
