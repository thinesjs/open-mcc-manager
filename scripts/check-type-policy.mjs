import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative, sep } from "node:path"
import ts from "typescript"

const UNKNOWN_ALLOWED = join("packages", "contracts", "src", "boundary")
const NEVER_ALLOWED = join("packages", "core", "src", "lib", "exhaustive.ts")
const SKIP = new Set(["node_modules", "dist", ".git", ".turbo"])

const walk = (dir, acc = []) => {
	for (const entry of readdirSync(dir)) {
		if (SKIP.has(entry)) continue
		const full = join(dir, entry)
		if (statSync(full).isDirectory()) walk(full, acc)
		else if (/\.tsx?$/.test(entry)) acc.push(full)
	}
	return acc
}

const isAsConst = (typeNode) =>
	typeNode.kind === ts.SyntaxKind.TypeReference &&
	ts.isIdentifier(typeNode.typeName) &&
	typeNode.typeName.text === "const"

const targetsForbiddenKeyword = (typeNode) =>
	typeNode.kind === ts.SyntaxKind.NeverKeyword || typeNode.kind === ts.SyntaxKind.UnknownKeyword

export const findViolations = (root) => {
	const violations = []
	const seen = new Set()
	for (const file of walk(root)) {
		const rel = relative(root, file)
		const inUnknownDir = rel === UNKNOWN_ALLOWED || rel.startsWith(UNKNOWN_ALLOWED + sep)
		const isNeverFile = rel === NEVER_ALLOWED
		const text = readFileSync(file, "utf8")
		const sf = ts.createSourceFile(
			rel,
			text,
			ts.ScriptTarget.Latest,
			true,
			rel.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
		)

		if (sf.parseDiagnostics.length > 0) {
			const lines = sf.parseDiagnostics.map(
				(d) => ts.getLineAndCharacterOfPosition(sf, d.start ?? 0).line + 1,
			)
			const line = Math.min(...lines)
			violations.push({ file: rel, line, token: "parse-error" })
			continue
		}

		const getLine = (node) => ts.getLineAndCharacterOfPosition(sf, node.getStart(sf)).line + 1

		const report = (node, token) => {
			const line = getLine(node)
			const key = `${rel}:${line}:${token}`
			if (!seen.has(key)) {
				seen.add(key)
				violations.push({ file: rel, line, token })
			}
		}

		const visit = (node) => {
			if (node.kind === ts.SyntaxKind.UnknownKeyword && !inUnknownDir) report(node, "unknown")
			if (node.kind === ts.SyntaxKind.NeverKeyword && !isNeverFile) report(node, "never")
			if (
				node.kind === ts.SyntaxKind.AsExpression &&
				!isAsConst(node.type) &&
				!targetsForbiddenKeyword(node.type)
			) {
				report(node, "assertion")
			}
			if (
				node.kind === ts.SyntaxKind.TypeAssertionExpression &&
				!targetsForbiddenKeyword(node.type)
			) {
				report(node, "assertion")
			}
			ts.forEachChild(node, visit)
		}

		visit(sf)
	}
	return violations
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const found = findViolations(process.cwd())
	for (const v of found) {
		const msg =
			v.token === "parse-error"
				? `${v.file}:${v.line} parse error`
				: `${v.file}:${v.line} forbidden token '${v.token}'`
		console.error(msg)
	}
	process.exit(found.length === 0 ? 0 : 1)
}
