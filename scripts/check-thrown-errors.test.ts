import { spawnSync } from "node:child_process"
import {
	copyFileSync,
	cpSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, describe, expect, it } from "vitest"
import { findInSource, findProblems, SCANNED } from "./check-thrown-errors.mjs"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

const CHECKER = join(ROOT, "scripts", "check-thrown-errors.mjs")

const made: string[] = []

const scratch = (): string => {
	const directory = mkdtempSync(join(tmpdir(), "thrown-errors-"))
	made.push(directory)
	return directory
}

const treeOf = (files: Record<string, string>): string => {
	const root = scratch()
	for (const [path, source] of Object.entries(files)) {
		const full = join(root, SCANNED, path)
		mkdirSync(dirname(full), { recursive: true })
		writeFileSync(full, source)
	}
	mkdirSync(join(root, SCANNED), { recursive: true })
	return root
}

const FINE = "export const fine = (): void => undefined\n"

const readLines = (path: string): { text: string; count: number } => {
	const text = readFileSync(path, "utf8")
	return { text, count: text.split("\n").length }
}

const run = (root: string): { status: number | null; output: string } => {
	const result = spawnSync("node", [CHECKER, root], { cwd: ROOT, encoding: "utf8" })
	return { status: result.status, output: `${result.stdout}${result.stderr}` }
}

afterAll(() => {
	for (const directory of made) rmSync(directory, { recursive: true, force: true })
})

describe("the one fact this gate decides", () => {
	it("★ names the file and the line of a bare throw, so the author is sent to it", () => {
		const root = treeOf({
			"host/raise.ts": 'const go = (): void => {\n\tthrow new Error("no")\n}\n',
		})

		const [problem] = findProblems(root)

		expect(problem).toContain(join(SCANNED, "host", "raise.ts:2"))
		expect(problem).toContain("throws a bare Error")
		expect(problem).toContain("InternalError")
	})

	it("★ leaves a named class alone, which is the whole way past this gate", () => {
		const root = treeOf({
			"host/named.ts":
				'class HostRefusedError extends Error {}\nclass InternalError extends Error {}\nconst go = (): void => {\n\tthrow new HostRefusedError("no")\n}\nconst inner = (): void => {\n\tthrow new InternalError("no")\n}\n',
		})

		expect(findProblems(root)).toEqual([])
	})

	it("★ reports Error called without new, which raises the very same object", () => {
		expect(findInSource("a.ts", 'throw Error("no")\n')).toHaveLength(1)
	})

	it("★ reports an Error built and not thrown, which is how reject(new Error(…)) hides", () => {
		const problems = findInSource(
			"a.ts",
			'const wait = new Promise((_, reject) => {\n\treject(new Error("no"))\n})\n',
		)

		expect(problems).toHaveLength(1)
		const [problem] = problems
		expect(problem).toContain("a.ts:2")
		expect(problem).toContain("builds a bare Error")
	})

	it("★ reads the parse tree, so a constructor named inside a string is not a throw", () => {
		expect(findInSource("a.ts", "const note = 'throw new Error(\"no\")'\n")).toEqual([])
	})

	it("★ reports only the constructor named Error, not every name ending in it", () => {
		expect(findInSource("a.ts", 'throw new HostRefusedError("no")\n')).toEqual([])
		expect(findInSource("a.ts", 'throw new MyError("no")\n')).toEqual([])
	})
})

describe("the tree it covers, which is why a new file is covered the day it is made", () => {
	it("★ reads a file in a directory that did not exist before, however deep", () => {
		const root = treeOf({
			"instance/live/new-surface.ts":
				'export const go = (): void => {\n\tthrow new Error("no")\n}\n',
		})

		const [problem] = findProblems(root)

		expect(problem).toContain(join(SCANNED, "instance", "live", "new-surface.ts:2"))
	})

	it("reads every file, not only the first one that has something to say", () => {
		const root = treeOf({
			"a.ts": 'throw new Error("no")\n',
			"b.ts": 'throw new Error("no")\n',
		})

		expect(findProblems(root)).toHaveLength(2)
	})

	it("skips a vendored tree, which this repository does not write", () => {
		const root = treeOf({
			"host/fine.ts": FINE,
			"node_modules/dep/index.ts": 'throw new Error("no")\n',
		})

		expect(findProblems(root)).toEqual([])
	})

	it("★ says so when the tree it names is gone, rather than passing on having found none", () => {
		const problems = findProblems(scratch())

		expect(problems).toHaveLength(1)
		const [problem] = problems
		expect(problem).toContain(SCANNED)
		expect(problem).toContain("is not a directory")
	})

	it("★ says so when the tree holds no source file, rather than passing without reading one", () => {
		const problems = findProblems(treeOf({}))

		expect(problems).toHaveLength(1)
		const [problem] = problems
		expect(problem).toContain("holds no source file")
	})

	it("★ reports a file it cannot parse, because a file it cannot read could hide anything", () => {
		const problems = findInSource("a.ts", "const broken = (\n")

		expect(problems).toHaveLength(1)
		const [problem] = problems
		expect(problem).toContain("does not parse")
	})
})

describe("the exemption for test files, and how far it reaches", () => {
	it("★ leaves a test file alone, because the boundaries here are tested with a plain Error", () => {
		const root = treeOf({ "host/fine.ts": FINE, "host/raise.test.ts": 'throw new Error("no")\n' })

		expect(findProblems(root)).toEqual([])
	})

	it("★ exempts that suffix alone, so a name that merely says test is still checked", () => {
		const root = treeOf({
			"test.ts": 'throw new Error("no")\n',
			"tests.ts": 'throw new Error("no")\n',
			"test/doubles.ts": 'throw new Error("no")\n',
			"host/raise.test-helper.ts": 'throw new Error("no")\n',
		})

		expect(findProblems(root)).toHaveLength(4)
	})
})

describe("the command pnpm lint runs", () => {
	it("exits 0 on the tree as it stands", () => {
		expect(run(ROOT).status).toBe(0)
	})

	it("★ exits 1 and names a bare throw added to a real core file", () => {
		const root = scratch()
		cpSync(join(ROOT, SCANNED), join(root, SCANNED), { recursive: true })
		const target = join(SCANNED, "instance", "console.ts")
		const added = 'export const boom = (): void => {\n\tthrow new Error("added by this test")\n}\n'
		const before = readLines(join(root, target))
		writeFileSync(join(root, target), `${before.text}\n${added}`)

		const { status, output } = run(root)

		expect(status).toBe(1)
		expect(output).toContain(`${target}:${before.count + 2} throws a bare Error`)
	})

	it("★ still runs from a path holding a space, rather than passing without checking", () => {
		const directory = mkdtempSync(join(tmpdir(), "a gate-"))
		made.push(directory)
		const copied = join(directory, "check-thrown-errors.mjs")
		copyFileSync(CHECKER, copied)
		symlinkSync(join(ROOT, "node_modules"), join(directory, "node_modules"), "dir")
		const root = treeOf({ "a.ts": 'throw new Error("no")\n' })

		const result = spawnSync("node", [copied, root], { encoding: "utf8" })

		expect(result.status).toBe(1)
		expect(`${result.stdout}${result.stderr}`).toContain("throws a bare Error")
	})
})
