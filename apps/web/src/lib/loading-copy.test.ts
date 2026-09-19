import { readdirSync, readFileSync, statSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")

const sources = (dir: string): string[] =>
	readdirSync(dir).flatMap((entry) => {
		const full = join(dir, entry)
		if (statSync(full).isDirectory()) return sources(full)
		return full.endsWith(".tsx") && !full.includes(".test.") ? [full] : []
	})

describe("how the interface says it is busy", () => {
	it("uses a spinner rather than words ending in an ellipsis", () => {
		const offenders = sources(root).flatMap((file) => {
			const text = readFileSync(file, "utf8")
			const matches = text.match(/"[A-Z][a-z]+ing…"/g) ?? []
			return matches.map((match) => `${file.replace(root, "")}: ${match}`)
		})

		expect(offenders).toEqual([])
	})

	it("does not render the word Loading as visible copy", () => {
		const offenders = sources(root).flatMap((file) => {
			const text = readFileSync(file, "utf8")
			return text.includes(">Loading") ? [file.replace(root, "")] : []
		})

		expect(offenders).toEqual([])
	})
})
