import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"

const ROOT = join(import.meta.dirname, "..", "apps", "web", "src", "routes")
const SKIP = new Set(["node_modules", "dist", "build", "coverage"])

const FORBIDDEN_NAMES = new Set(["LoadingBlock", "Spinner", "PageShimmer", "PageLoading"])

const FORBIDDEN_MODULES = ["components/ui/spinner", "components/ui/shimmer"]

export const EXEMPT_ROUTES = new Map([
	["_authenticated.tsx", "the layout owns the PageBoundary every other route inherits"],
	[
		"_authenticated.audit.tsx",
		"its paged list query needs enabled and placeholderData, which useSuspenseQuery supports neither of",
	],
])

const NAMED_IMPORT = /import\s+(?:type\s+)?\{([\s\S]*?)\}\s*from\s*["'][^"']+["']/g
const MODULE_SPECIFIER = /(?:\bfrom|\bimport)\s*\(?\s*["']([^"']+)["']/g

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
			if (!FORBIDDEN_NAMES.has(imported)) continue
			found.push(
				`${label}:${lineOf(source, match.index ?? 0)} a route imports ${imported}; ${ADVICE}`,
			)
		}
	}
	for (const match of source.matchAll(MODULE_SPECIFIER)) {
		const specifier = match[1] ?? ""
		const owner = FORBIDDEN_MODULES.find((module) => specifier.endsWith(module))
		if (owner === undefined) continue
		found.push(`${label}:${lineOf(source, match.index ?? 0)} a route imports ${owner}; ${ADVICE}`)
	}
	return found
}

const violations = walk(ROOT).flatMap((file) => {
	const rel = relative(ROOT, file)
	if (EXEMPT_ROUTES.has(rel)) return []
	return findViolations(readFileSync(file, "utf8"), join("apps", "web", "src", "routes", rel))
})

if (violations.length > 0) {
	for (const violation of violations) process.stdout.write(`${violation}\n`)
	process.exit(1)
}
