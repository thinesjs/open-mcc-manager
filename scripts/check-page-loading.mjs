import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"

const ROOT = join(import.meta.dirname, "..", "apps", "web", "src", "routes")
const SKIP = new Set(["node_modules", "dist", "build", "coverage"])

const FORBIDDEN = new Set(["LoadingBlock", "Spinner"])

export const AWAITING_ANOTHER_BRANCH = new Set(["_authenticated.instances.$instanceId.tsx"])

const NAMED_IMPORT = /import\s+(?:type\s+)?\{([\s\S]*?)\}\s*from\s*["'][^"']+["']/g

const ADVICE =
	"page content shimmers through the PageBoundary around <Outlet /> in _authenticated.tsx, so declare the page's data with useSuspenseQuery and delete the branch; a small in-place wait (modal, card, button, row action) belongs in a component under apps/web/src/components/"

const walk = (dir, found = []) => {
	for (const entry of readdirSync(dir).sort()) {
		if (SKIP.has(entry)) continue
		const full = join(dir, entry)
		if (statSync(full).isDirectory()) walk(full, found)
		else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) found.push(full)
	}
	return found
}

const lineOf = (source, index) => source.slice(0, index).split("\n").length

export const findViolations = (source, label) => {
	const found = []
	for (const match of source.matchAll(NAMED_IMPORT)) {
		for (const binding of (match[1] ?? "").split(",")) {
			const imported =
				binding
					.trim()
					.split(/\s+as\s+/)[0]
					?.trim() ?? ""
			if (!FORBIDDEN.has(imported)) continue
			found.push(
				`${label}:${lineOf(source, match.index ?? 0)} a route imports ${imported}; ${ADVICE}`,
			)
		}
	}
	return found
}

const violations = walk(ROOT).flatMap((file) => {
	const rel = relative(ROOT, file)
	if (AWAITING_ANOTHER_BRANCH.has(rel)) return []
	return findViolations(readFileSync(file, "utf8"), join("apps", "web", "src", "routes", rel))
})

if (violations.length > 0) {
	for (const violation of violations) process.stdout.write(`${violation}\n`)
	process.exit(1)
}
