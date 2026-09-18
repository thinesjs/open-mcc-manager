import { readdirSync, readFileSync, statSync } from "node:fs"
import { basename, dirname, join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

const SKIP = new Set([
	"node_modules",
	"dist",
	"build",
	"coverage",
	".git",
	".turbo",
	".superpowers",
])

const SKIP_AT_ROOT = new Set([".claude", ".work"])

const walk = (dir: string, root: string, found: string[] = []): string[] => {
	for (const entry of readdirSync(dir).sort()) {
		if (SKIP.has(entry)) continue
		if (dir === root && SKIP_AT_ROOT.has(entry)) continue
		const full = join(dir, entry)
		if (statSync(full).isDirectory()) walk(full, root, found)
		else if (entry.endsWith(".mjs")) found.push(relative(root, full))
	}
	return found
}

const COMPARISON = /[=!]==?/

export const guardProblems = (label: string, source: string): string[] => {
	const problems: string[] = []
	const suffix = `?.endsWith("${basename(label)}")`
	for (const [index, line] of source.split("\n").entries()) {
		const at = `${label}:${index + 1}`
		if (line.includes("import.meta.url") && COMPARISON.test(line)) {
			problems.push(
				`${at} guards on a comparison of import.meta.url, which node percent-encodes and resolves through symlinks while leaving process.argv[1] alone, so this exits 0 having checked nothing from a path holding a space; use process.argv[1]${suffix}`,
			)
		}
		if (line.includes("process.argv[1]") && !line.includes(suffix)) {
			problems.push(
				`${at} reads process.argv[1] without ${suffix}, the one guard form allowed here`,
			)
		}
	}
	return problems
}

const FOUND = walk(ROOT, ROOT)

const GOOD = 'if (process.argv[1]?.endsWith("check-page-loading.mjs")) main()\n'

const LABEL = join("scripts", "check-page-loading.mjs")

describe("the one shape a main guard may take", () => {
	it("★ accepts the suffix guard naming the file it sits in", () => {
		expect(guardProblems(LABEL, GOOD)).toEqual([])
	})

	it("★ accepts a script with no main guard at all, which cannot get the comparison wrong", () => {
		const source = "const found = walk(ROOT)\nif (found.length > 0) process.exit(1)\n"
		expect(guardProblems(LABEL, source)).toEqual([])
	})

	it("★ rejects the template form that made two gates exit 0 from a path holding a space", () => {
		const source = "if (import.meta.url === `file://\u0024{process.argv[1]}`) {\n\tmain()\n}\n"
		const [problem] = guardProblems(LABEL, source)
		expect(problem).toContain(`${LABEL}:1`)
		expect(problem).toContain("percent-encodes")
	})

	it("★ rejects the encoded url comparison, which is still false under a symlinked temp path", () => {
		const source = "if (import.meta.url === pathToFileURL(process.argv[1]).href) main()\n"
		expect(guardProblems(LABEL, source).length).toBeGreaterThan(0)
	})

	it("★ rejects comparing the resolved paths, where argv[1] is left unresolved", () => {
		const source = "if (fileURLToPath(import.meta.url) === resolve(process.argv[1])) main()\n"
		expect(guardProblems(LABEL, source).length).toBeGreaterThan(0)
	})

	it("★ rejects a suffix that is not this file's own name, which any sibling would match", () => {
		const [problem] = guardProblems(LABEL, 'if (process.argv[1]?.endsWith(".mjs")) main()\n')
		expect(problem).toContain('?.endsWith("check-page-loading.mjs")')
	})

	it("★ leaves import.meta.url alone where nothing is compared, as load-env.mjs reads it", () => {
		const source = 'const envFile = fileURLToPath(new URL("../../.env", import.meta.url))\n'
		expect(guardProblems(LABEL, source)).toEqual([])
	})

	it("★ leaves import.meta.dirname alone, which carries no encoding at all", () => {
		const source = 'const DOCUMENT = join(import.meta.dirname, "..", "AGENTS.md")\n'
		expect(guardProblems(LABEL, source)).toEqual([])
	})
})

describe("every mjs in this repository, walked rather than listed", () => {
	it("★ holds every one of them to that shape", () => {
		expect(
			FOUND.flatMap((file) => guardProblems(file, readFileSync(join(ROOT, file), "utf8"))),
		).toEqual([])
	})

	it("★ reaches lint.mjs, where a regressed guard would disarm all eight checkers at once", () => {
		expect(FOUND).toContain(join("scripts", "lint.mjs"))
	})

	it("★ recurses, so a script added in a new directory is covered the day it is made", () => {
		expect(FOUND.length).toBeGreaterThan(5)
		expect(new Set(FOUND.map((file) => dirname(file))).size).toBeGreaterThan(1)
	})
})
