import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative, sep } from "node:path"
import ts from "typescript"

const UNKNOWN_ALLOWED = join("packages", "contracts", "src", "boundary")
const NEVER_ALLOWED = join("packages", "core", "src", "lib", "exhaustive.ts")
const SKIP = new Set(["node_modules", "dist", "build", "coverage", ".git", ".turbo"])

const GENERATED_FILES = new Set([join("apps", "web", "src", "routeTree.gen.ts")])
const COMMENT_ALLOWED_FILES = new Set([join("packages", "db", "src", "generated", "database.ts")])

const SOURCE_FILE = /\.(?:[cm]?ts|tsx)$/
const MANIFEST_FILE = "package.json"

const walk = (dir, root, acc = { sources: [], manifests: [] }) => {
	for (const entry of readdirSync(dir).sort()) {
		if (SKIP.has(entry)) continue
		const full = join(dir, entry)
		if (statSync(full).isDirectory()) {
			walk(full, root, acc)
			continue
		}
		if (GENERATED_FILES.has(relative(root, full))) continue
		if (entry === MANIFEST_FILE) acc.manifests.push(full)
		else if (SOURCE_FILE.test(entry)) acc.sources.push(full)
	}
	return acc
}

const isAsConst = (typeNode) =>
	typeNode.kind === ts.SyntaxKind.TypeReference &&
	ts.isIdentifier(typeNode.typeName) &&
	typeNode.typeName.text === "const"

const DIRECTIVE_LINE = /^(?:\/|\*)*\s*@(ts-expect-error|ts-ignore|ts-nocheck)/

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

const NEXT_SPECIFIER = /^next(?:\/|$)/
const NEXT_PACKAGE = /^(?:next|@next\/.+)$/
const DEPENDENCY_FIELDS = [
	"dependencies",
	"devDependencies",
	"peerDependencies",
	"optionalDependencies",
]

const moduleSpecifierOf = (node) => {
	if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return node.moduleSpecifier
	if (ts.isImportTypeNode(node))
		return ts.isLiteralTypeNode(node.argument) ? node.argument.literal : undefined
	if (ts.isExternalModuleReference(node)) return node.expression
	if (ts.isCallExpression(node)) {
		const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword
		const isRequire = ts.isIdentifier(node.expression) && node.expression.text === "require"
		if (isDynamicImport || isRequire) return node.arguments[0]
	}
	return undefined
}

const lineOfIndex = (text, index) => text.slice(0, index).split("\n").length

const manifestViolations = (rel, text) => {
	let manifest
	try {
		manifest = JSON.parse(text)
	} catch {
		return [{ file: rel, line: 1, token: "parse-error" }]
	}
	if (manifest === null || typeof manifest !== "object") return []
	const names = new Set()
	for (const field of DEPENDENCY_FIELDS) {
		const block = manifest[field]
		if (block === null || typeof block !== "object") continue
		for (const name of Object.keys(block)) if (NEXT_PACKAGE.test(name)) names.add(name)
	}
	return [...names].sort().map((name) => {
		const index = text.indexOf(`"${name}"`)
		return { file: rel, line: index === -1 ? 1 : lineOfIndex(text, index), token: "next" }
	})
}

const sourceViolations = (rel, text) => {
	const violations = []
	const seen = new Set()
	const inUnknownDir = rel === UNKNOWN_ALLOWED || rel.startsWith(UNKNOWN_ALLOWED + sep)
	const isNeverFile = rel === NEVER_ALLOWED
	const commentsAllowed = COMMENT_ALLOWED_FILES.has(rel)
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
		return [{ file: rel, line: Math.min(...lines), token: "parse-error" }]
	}

	const getLine = (node) => ts.getLineAndCharacterOfPosition(sf, node.getStart(sf)).line + 1

	const reportAt = (line, token) => {
		const key = `${rel}:${line}:${token}`
		if (seen.has(key)) return
		seen.add(key)
		violations.push({ file: rel, line, token })
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

	const visitSpecifiers = (node) => {
		const specifier = moduleSpecifierOf(node)
		if (specifier && ts.isStringLiteral(specifier) && NEXT_SPECIFIER.test(specifier.text)) {
			report(specifier, "next")
		}
		ts.forEachChild(node, visitSpecifiers)
	}

	visitKeywords(sf)
	visitAssertions(sf)
	visitSpecifiers(sf)

	for (const range of collectCommentRanges(sf, text)) {
		const startLine = ts.getLineAndCharacterOfPosition(sf, range.pos).line + 1
		const directive = directiveIn(text.slice(range.pos, range.end))
		if (directive) reportAt(startLine + directive.offset, directive.token)
		else if (!commentsAllowed) reportAt(startLine, "comment")
	}

	return violations
}

export const findViolations = (root) => {
	const violations = []
	const { sources, manifests } = walk(root, root)
	for (const file of sources) {
		violations.push(...sourceViolations(relative(root, file), readFileSync(file, "utf8")))
	}
	for (const file of manifests) {
		violations.push(...manifestViolations(relative(root, file), readFileSync(file, "utf8")))
	}
	return violations
}

const describe = (violation) => {
	if (violation.token === "parse-error") return "parse error"
	if (violation.token === "comment") return "code comment"
	if (violation.token === "next") return "forbidden dependency on next"
	return `forbidden token '${violation.token}'`
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const found = findViolations(process.cwd())
	for (const violation of found) {
		console.error(`${violation.file}:${violation.line} ${describe(violation)}`)
	}
	process.exit(found.length === 0 ? 0 : 1)
}
