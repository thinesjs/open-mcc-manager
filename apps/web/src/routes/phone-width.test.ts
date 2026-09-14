import { readdirSync, readFileSync, statSync } from "node:fs"
import { dirname, join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const src = join(dirname(fileURLToPath(import.meta.url)), "..")

const sources = (dir: string): string[] =>
	readdirSync(dir).flatMap((entry) => {
		const full = join(dir, entry)
		if (statSync(full).isDirectory()) return sources(full)
		return entry.endsWith(".tsx") && !entry.endsWith(".test.tsx") ? [full] : []
	})

const classNamesIn = (source: string): string[] =>
	[...source.matchAll(/className="([^"]*)"/g)].map((match) => match[1] ?? "")

const tables = sources(src).flatMap((file) => {
	const source = readFileSync(file, "utf8")
	return [...source.matchAll(/<table\b/g)].map((match) => ({
		file: relative(src, file),
		box: classNamesIn(source.slice(0, match.index)).at(-1) ?? "",
	}))
})

describe("a table on a phone", () => {
	it("exists somewhere, so this check is not vacuous", () => {
		expect(tables.length).toBeGreaterThan(0)
	})

	it.each(tables)("scrolls sideways inside its own box in $file", ({ box }) => {
		expect(box).toMatch(/\boverflow-x-auto\b/)
	})
})

describe("an alert destination card on a phone", () => {
	const alerts = readFileSync(join(src, "routes", "_authenticated.alerts.tsx"), "utf8")
	const header = classNamesIn(
		alerts.slice(alerts.indexOf("key={destination.id}"), alerts.indexOf('may("edit")')),
	)

	it("lets the name and the actions wrap onto their own lines", () => {
		expect(header.find((name) => name.includes("justify-between"))).toMatch(/\bflex-wrap\b/)
	})

	it("lets the actions wrap rather than refusing to shrink past the screen", () => {
		const actions = header.at(-1) ?? ""

		expect(actions).toMatch(/\bflex-wrap\b/)
		expect(actions).not.toMatch(/\bshrink-0\b/)
	})
})
