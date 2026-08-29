import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative, sep } from "node:path"

const UNKNOWN_ALLOWED = join("packages", "contracts", "src", "boundary")
const NEVER_ALLOWED = join("packages", "core", "src", "lib", "exhaustive.ts")
const SKIP = new Set(["node_modules", "dist", ".git", ".turbo"])

const walk = (dir, acc = []) => {
	for (const entry of readdirSync(dir)) {
		if (SKIP.has(entry)) continue
		const full = join(dir, entry)
		if (statSync(full).isDirectory()) walk(full, acc)
		else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) acc.push(full)
	}
	return acc
}

const stripNoise = (line) =>
	line.replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/'(?:[^'\\]|\\.)*'/g, "''")

export const findViolations = (root) => {
	const violations = []
	for (const file of walk(root)) {
		const rel = relative(root, file)
		const inUnknownDir = rel.split(sep).join(sep).startsWith(UNKNOWN_ALLOWED)
		const isNeverFile = rel === NEVER_ALLOWED
		const lines = readFileSync(file, "utf8").split("\n")
		lines.forEach((raw, index) => {
			const line = stripNoise(raw)
			if (!inUnknownDir && /\bunknown\b/.test(line))
				violations.push({ file: rel, line: index + 1, token: "unknown" })
			if (!isNeverFile && /\bnever\b/.test(line))
				violations.push({ file: rel, line: index + 1, token: "never" })
		})
	}
	return violations
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const found = findViolations(process.cwd())
	for (const v of found) console.error(`${v.file}:${v.line} forbidden token '${v.token}'`)
	process.exit(found.length === 0 ? 0 : 1)
}
