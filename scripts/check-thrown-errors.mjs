import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import ts from "typescript"

const DEFAULT_ROOT = join(import.meta.dirname, "..")

export const SCANNED = join("packages", "core", "src")

const SKIP = new Set([
	"node_modules",
	"dist",
	"build",
	"coverage",
	".git",
	".turbo",
	".superpowers",
])

const SOURCE_FILE = /\.(?:[cm]?ts|tsx)$/
const TEST_FILE = /\.test\.(?:[cm]?ts|tsx)$/

export const ADVICE = "throw a named class, or InternalError when no operator is waiting on it"

const walk = (dir, found = []) => {
	for (const entry of readdirSync(dir).sort()) {
		if (SKIP.has(entry)) continue
		const full = join(dir, entry)
		if (statSync(full).isDirectory()) {
			walk(full, found)
			continue
		}
		if (SOURCE_FILE.test(entry) && !TEST_FILE.test(entry)) found.push(full)
	}
	return found
}

const isBareError = (node) =>
	(ts.isNewExpression(node) || ts.isCallExpression(node)) &&
	ts.isIdentifier(node.expression) &&
	node.expression.text === "Error"

export const findInSource = (label, text) => {
	const sf = ts.createSourceFile(
		label,
		text,
		ts.ScriptTarget.Latest,
		true,
		label.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
	)

	if (sf.parseDiagnostics.length > 0) {
		const lines = sf.parseDiagnostics.map(
			(diagnostic) => ts.getLineAndCharacterOfPosition(sf, diagnostic.start ?? 0).line + 1,
		)
		return [
			`${label}:${Math.min(...lines)} does not parse, so nothing can be read out of it; a file this gate cannot read could hide anything`,
		]
	}

	const found = []
	const visit = (node) => {
		if (isBareError(node)) {
			const line = ts.getLineAndCharacterOfPosition(sf, node.getStart(sf)).line + 1
			const raised = node.parent !== undefined && ts.isThrowStatement(node.parent)
			found.push(`${label}:${line} ${raised ? "throws" : "builds"} a bare Error; ${ADVICE}`)
		}
		ts.forEachChild(node, visit)
	}
	visit(sf)
	return found
}

export const findProblems = (root = DEFAULT_ROOT) => {
	const scanned = join(root, SCANNED)
	if (!statSync(scanned, { throwIfNoEntry: false })?.isDirectory()) {
		return [
			`${SCANNED} is not a directory under ${root}; this gate covers that tree alone, so moving it moves the rule with it`,
		]
	}

	const files = walk(scanned)
	if (files.length === 0) {
		return [`${SCANNED} holds no source file to check, so this gate would pass without reading one`]
	}

	return files.flatMap((file) => findInSource(relative(root, file), readFileSync(file, "utf8")))
}

const main = () => {
	const found = findProblems(process.argv[2] ?? DEFAULT_ROOT)
	for (const problem of found) console.error(problem)
	process.exit(found.length === 0 ? 0 : 1)
}

if (process.argv[1]?.endsWith("check-thrown-errors.mjs")) main()
