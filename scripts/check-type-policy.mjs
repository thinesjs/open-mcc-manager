import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative, sep } from "node:path"
import ts from "typescript"

const UNKNOWN_ALLOWED = join("packages", "contracts", "src", "boundary")
const NEVER_ALLOWED = join("packages", "core", "src", "lib", "exhaustive.ts")
const SKIP = new Set(["node_modules", "dist", "build", "coverage", ".git", ".turbo"])

const GENERATED_FILES = new Set([join("apps", "web", "src", "routeTree.gen.ts")])

const SOURCE_FILE = /\.(?:[cm]?ts|tsx)$/

const walk = (dir, root, acc = []) => {
	for (const entry of readdirSync(dir).sort()) {
		if (SKIP.has(entry)) continue
		const full = join(dir, entry)
		if (GENERATED_FILES.has(relative(root, full))) continue
		if (statSync(full).isDirectory()) walk(full, root, acc)
		else if (SOURCE_FILE.test(entry)) acc.push(full)
	}
	return acc
}

const isAsConst = (typeNode) =>
	typeNode.kind === ts.SyntaxKind.TypeReference &&
	ts.isIdentifier(typeNode.typeName) &&
	typeNode.typeName.text === "const"

const DIRECTIVE_LINE = /^(?:\/|\*)*\s*@(ts-expect-error|ts-ignore)/

const directiveIn = (commentText) => {
	const lines = commentText.split(/\r\n|\n|\r/)
	for (let offset = 0; offset < lines.length; offset += 1) {
		const match = DIRECTIVE_LINE.exec(lines[offset].trimStart())
		if (match) return { token: `@${match[1]}`, offset }
	}
	return undefined
}

const collectCommentRanges = (sf, text) => {
	const ranges = []
	const seen = new Set()
	const add = (found) => {
		if (!found) return
		for (const range of found) {
			if (seen.has(range.pos)) continue
			seen.add(range.pos)
			ranges.push(range)
		}
	}
	const visit = (node) => {
		const start = node.getFullStart()
		add(ts.getLeadingCommentRanges(text, start))
		add(ts.getTrailingCommentRanges(text, start))
		for (const child of node.getChildren(sf)) visit(child)
	}
	visit(sf)
	return ranges.sort((a, b) => a.pos - b.pos)
}

export const findViolations = (root) => {
	const violations = []
	const seen = new Set()
	for (const file of walk(root, root)) {
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

		const reportAt = (line, token) => {
			const key = `${rel}:${line}:${token}`
			if (!seen.has(key)) {
				seen.add(key)
				violations.push({ file: rel, line, token })
			}
		}

		const report = (node, token) => reportAt(getLine(node), token)

		const keywordViolationLines = new Set()

		const visitKeywords = (node) => {
			if (node.kind === ts.SyntaxKind.UnknownKeyword && !inUnknownDir) {
				keywordViolationLines.add(getLine(node))
				report(node, "unknown")
			}
			if (node.kind === ts.SyntaxKind.NeverKeyword && !isNeverFile) {
				keywordViolationLines.add(getLine(node))
				report(node, "never")
			}
			ts.forEachChild(node, visitKeywords)
		}

		const visitAssertions = (node) => {
			if (node.kind === ts.SyntaxKind.AsExpression && !isAsConst(node.type)) {
				if (!keywordViolationLines.has(getLine(node))) report(node, "assertion")
			}
			if (node.kind === ts.SyntaxKind.TypeAssertionExpression) {
				if (!keywordViolationLines.has(getLine(node))) report(node, "assertion")
			}
			if (
				(node.kind === ts.SyntaxKind.VariableDeclaration ||
					node.kind === ts.SyntaxKind.PropertyDeclaration) &&
				node.exclamationToken
			) {
				report(node.exclamationToken, "definite-assignment")
			}
			ts.forEachChild(node, visitAssertions)
		}

		visitKeywords(sf)
		visitAssertions(sf)

		for (const range of collectCommentRanges(sf, text)) {
			const directive = directiveIn(text.slice(range.pos, range.end))
			if (directive) {
				const line = ts.getLineAndCharacterOfPosition(sf, range.pos).line + 1
				reportAt(line + directive.offset, directive.token)
			}
		}
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
