import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"

const ROOT = join(import.meta.dirname, "..", "apps", "web", "src")
const SKIP = new Set(["node_modules", "dist", "build", "coverage"])

const PRIMITIVES = new Set([
	join("components", "ui", "button.tsx"),
	join("components", "ui", "input.tsx"),
	join("components", "ui", "select.tsx"),
	join("components", "ui", "badge.tsx"),
])

const CONTROL_SIZING = /\b(?:sm:|md:|lg:)?(?:h|size)-(?:7|8|9|10|11|12)\b|\bpy-(?:2\.5|3|3\.5|4)\b/

const INTERACTIVE_OPENER = /<(button|a)[\s>]/g
const ANY_OPENER = /<([A-Za-z][A-Za-z0-9]*)[\s>/]/g
const CLASS_NAME = /className=(?:"([^"]*)"|\{cn\(([\s\S]{0,400}?)\)\})/g

const walk = (dir, found = []) => {
	for (const entry of readdirSync(dir).sort()) {
		if (SKIP.has(entry)) continue
		const full = join(dir, entry)
		if (statSync(full).isDirectory()) walk(full, found)
		else if (entry.endsWith(".tsx") && !entry.endsWith(".test.tsx")) found.push(full)
	}
	return found
}

const lineOf = (source, index) => source.slice(0, index).split("\n").length

export const findViolations = (source, label) => {
	const openers = []
	for (const match of source.matchAll(ANY_OPENER)) {
		openers.push({ index: match.index ?? 0, tag: match[1] ?? "" })
	}

	const interactive = new Set()
	for (const match of source.matchAll(INTERACTIVE_OPENER)) interactive.add(match.index ?? 0)

	const found = []
	for (const match of source.matchAll(CLASS_NAME)) {
		const at = match.index ?? 0
		const value = `${match[1] ?? ""}${match[2] ?? ""}`
		if (!CONTROL_SIZING.test(value)) continue
		if (value.includes("buttonVariants")) continue

		let owner
		for (const opener of openers) {
			if (opener.index < at) owner = opener
			else break
		}
		if (!owner || !interactive.has(owner.index)) continue

		found.push(
			`${label}:${lineOf(source, at)} an interactive <${owner.tag}> sets its own size; use buttonVariants() so it cannot drift from Button`,
		)
	}
	return found
}

const violations = walk(ROOT).flatMap((file) => {
	const rel = relative(ROOT, file)
	if (PRIMITIVES.has(rel)) return []
	return findViolations(readFileSync(file, "utf8"), join("apps", "web", "src", rel))
})

if (violations.length > 0) {
	for (const violation of violations) process.stdout.write(`${violation}\n`)
	process.exit(1)
}
