import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const STYLESHEET = "apps/web/src/index.css"

const collapse = (value) => value.trim().replace(/\s+/g, " ")

const keyOf = (declaration) => JSON.stringify([declaration.scope, declaration.name])

export const stripComments = (source) => source.replace(/\/\*[\s\S]*?\*\//g, "")

export const parseDeclarations = (source) => {
	const declarations = []
	const scopes = []
	let buffer = ""
	for (const character of stripComments(source)) {
		if (character === "{") {
			scopes.push(collapse(buffer))
			buffer = ""
			continue
		}
		if (character === "}" || character === ";") {
			if (character === "}") scopes.pop()
			const separator = buffer.indexOf(":")
			const name = separator === -1 ? "" : buffer.slice(0, separator).trim()
			if (name.startsWith("--")) {
				declarations.push({
					scope: scopes.join(" > "),
					name,
					value: collapse(buffer.slice(separator + 1)),
				})
			}
			buffer = ""
			continue
		}
		buffer += character
	}
	return declarations
}

export const compareTokens = (ours, reference) => {
	const byKey = new Map()
	for (const declaration of reference) byKey.set(keyOf(declaration), declaration.value)
	const identical = []
	const differing = []
	const unmatched = []
	for (const declaration of ours) {
		const key = keyOf(declaration)
		if (!byKey.has(key)) unmatched.push(declaration)
		else if (byKey.get(key) === declaration.value) identical.push(declaration)
		else differing.push({ ...declaration, reference: byKey.get(key) })
	}
	return { compared: ours.length, identical, differing, unmatched }
}

export const readReference = (checkoutPath) => {
	const described = execFileSync(
		"git",
		["-C", checkoutPath, "log", "-1", "--format=%h %ad", "--date=short"],
		{ encoding: "utf8" },
	).trim()
	const [commit, date] = described.split(" ")
	return { checkoutPath, commit, date }
}

export const formatReport = (reference, comparison) => {
	const lines = [
		`the reference token mirror, ${STYLESHEET} against ${reference.commit} (${reference.date})`,
		`reference checkout: ${reference.checkoutPath}`,
		`${comparison.compared} declarations compared: ${comparison.identical.length} identical, ${comparison.differing.length} differing, ${comparison.unmatched.length} absent from the reference`,
	]
	for (const declaration of comparison.differing) {
		lines.push(
			`differs  [${declaration.scope}] ${declaration.name}`,
			`    ours      ${declaration.value}`,
			`    reference ${declaration.reference}`,
		)
	}
	for (const declaration of comparison.unmatched) {
		lines.push(`absent   [${declaration.scope}] ${declaration.name} = ${declaration.value}`)
	}
	return lines.join("\n")
}

export const compareCheckout = (checkoutPath, repoRoot) => {
	const reference = readReference(checkoutPath)
	const comparison = compareTokens(
		parseDeclarations(readFileSync(join(repoRoot, STYLESHEET), "utf8")),
		parseDeclarations(readFileSync(join(checkoutPath, STYLESHEET), "utf8")),
	)
	return { reference, comparison }
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const checkoutPath = process.argv[2]
	if (!checkoutPath) {
		console.error(
			"usage: node scripts/compare-the reference-tokens.mjs <path-to-the reference-checkout>\nThe reference checkout is required; this script never guesses which clone to compare against.",
		)
		process.exit(2)
	}
	const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..")
	const { reference, comparison } = compareCheckout(checkoutPath, repoRoot)
	process.stdout.write(`${formatReport(reference, comparison)}\n`)
	process.exit(comparison.differing.length + comparison.unmatched.length === 0 ? 0 : 1)
}
