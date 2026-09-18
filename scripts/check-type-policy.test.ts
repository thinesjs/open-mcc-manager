import { spawnSync } from "node:child_process"
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, describe, expect, it } from "vitest"
import { findViolations } from "./check-type-policy.mjs"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

const CHECKER = join(ROOT, "scripts", "check-type-policy.mjs")

const made: string[] = []

const scratch = (prefix: string): string => {
	const directory = mkdtempSync(join(tmpdir(), prefix))
	made.push(directory)
	return directory
}

const seed = (files: Record<string, string>): string => {
	const root = scratch("policy-")
	for (const [rel, body] of Object.entries(files)) {
		const full = join(root, rel)
		mkdirSync(join(full, ".."), { recursive: true })
		writeFileSync(full, body)
	}
	return root
}

afterAll(() => {
	for (const directory of made) rmSync(directory, { recursive: true, force: true })
})

describe("findViolations", () => {
	it("rejects unknown outside the boundary directory", () => {
		const root = seed({ "packages/core/src/a.ts": "const x: unknown = 1\n" })
		expect(findViolations(root)).toEqual([
			{ file: "packages/core/src/a.ts", line: 1, token: "unknown" },
		])
	})

	it("allows unknown inside the boundary directory", () => {
		const root = seed({
			"packages/contracts/src/boundary/b.ts": "const x: unknown = 1\n",
		})
		expect(findViolations(root)).toEqual([])
	})

	it("allows never only in the exhaustive helper", () => {
		const root = seed({
			"packages/core/src/lib/exhaustive.ts": "export const f = (v: never): never => v\n",
			"packages/core/src/b.ts": "const y: never = 1 as never\n",
		})
		expect(findViolations(root)).toEqual([
			{ file: "packages/core/src/b.ts", line: 1, token: "never" },
		])
	})

	it("ignores the words inside identifiers and strings", () => {
		const root = seed({ "packages/core/src/c.ts": 'const unknownish = "never mind"\n' })
		expect(findViolations(root)).toEqual([])
	})

	it("rejects unknown in paths that start with but are not under boundary", () => {
		const root = seed({
			"packages/contracts/src/boundary-leak/x.ts": "const x: unknown = 1\n",
			"packages/contracts/src/boundary-old.ts": "const x: unknown = 1\n",
		})
		expect(findViolations(root)).toEqual([
			{ file: "packages/contracts/src/boundary-leak/x.ts", line: 1, token: "unknown" },
			{ file: "packages/contracts/src/boundary-old.ts", line: 1, token: "unknown" },
		])
	})

	it("allows unknown in nested paths under boundary", () => {
		const root = seed({
			"packages/contracts/src/boundary/nested/deep.ts": "const x: unknown = 1\n",
		})
		expect(findViolations(root)).toEqual([])
	})

	it("scans test files and reports violations", () => {
		const root = seed({ "packages/core/src/a.test.ts": "const x: unknown = 1\n" })
		expect(findViolations(root)).toEqual([
			{ file: "packages/core/src/a.test.ts", line: 1, token: "unknown" },
		])
	})

	it("ignores tokens inside template literals", () => {
		const root = seed({
			"packages/core/src/d.ts": "const msg = `the value is unknown here`\n",
		})
		expect(findViolations(root)).toEqual([])
	})

	it("reports a comment as a comment, not as the forbidden words written inside it", () => {
		const root = seed({
			"packages/core/src/e.ts": "// this function should never return unknown\n",
		})
		expect(findViolations(root)).toEqual([
			{ file: "packages/core/src/e.ts", line: 1, token: "comment" },
		])
	})

	it("detects violations hidden by url-like patterns in block comments", () => {
		const root = seed({
			"packages/core/src/f.ts": "/* see http://example.com */ const leak: unknown = 1\n",
			"packages/core/src/g.ts": "/* docs http://x.io/spec */ const leak2: never = 1 as never\n",
		})
		expect(findViolations(root)).toEqual([
			{ file: "packages/core/src/f.ts", line: 1, token: "unknown" },
			{ file: "packages/core/src/f.ts", line: 1, token: "comment" },
			{ file: "packages/core/src/g.ts", line: 1, token: "never" },
			{ file: "packages/core/src/g.ts", line: 1, token: "comment" },
		])
	})

	it("reports a multi-line block comment once, not once per forbidden word inside it", () => {
		const root = seed({
			"packages/core/src/h.ts": "/*\n * never returns unknown\n */\nexport const ok = 1\n",
		})
		expect(findViolations(root)).toEqual([
			{ file: "packages/core/src/h.ts", line: 1, token: "comment" },
		])
	})

	it("detects violations when regex literals are present", () => {
		const root = seed({
			"packages/core/src/i.ts": "const re = /https:\\/\\//\nconst x: unknown = 1\n",
		})
		expect(findViolations(root)).toEqual([
			{ file: "packages/core/src/i.ts", line: 2, token: "unknown" },
		])
	})

	it("scans tsx files correctly", () => {
		const root = seed({ "packages/core/src/j.tsx": "const x: unknown = 1\n" })
		expect(findViolations(root)).toEqual([
			{ file: "packages/core/src/j.tsx", line: 1, token: "unknown" },
		])
	})

	it("detects violations when string literals contain slashes", () => {
		const root = seed({
			"packages/core/src/k.ts": 'const s = "a//b"\nconst x: unknown = 1\n',
		})
		expect(findViolations(root)).toEqual([
			{ file: "packages/core/src/k.ts", line: 2, token: "unknown" },
		])
	})

	it("reports parse errors that hide forbidden tokens", () => {
		const root = seed({
			"packages/core/src/l.ts": "function broken( {\nconst x: unknown = 1\n",
		})
		expect(findViolations(root)).toEqual([
			{ file: "packages/core/src/l.ts", line: 2, token: "parse-error" },
		])
	})

	it("does not report parse-error for syntactically valid files", () => {
		const root = seed({
			"packages/core/src/m.ts": "const x: unknown = 1\n",
		})
		expect(findViolations(root)).toEqual([
			{ file: "packages/core/src/m.ts", line: 1, token: "unknown" },
		])
	})

	it("reports parse errors exactly once without walking", () => {
		const root = seed({
			"packages/core/src/n.ts": "function broken( {\nconst x: unknown = 1\nconst y: never = 2\n",
		})
		expect(findViolations(root)).toEqual([
			{ file: "packages/core/src/n.ts", line: 2, token: "parse-error" },
		])
	})

	it("allows an as const assertion", () => {
		const root = seed({ "packages/core/src/o.ts": "const x = 1 as const\n" })
		expect(findViolations(root)).toEqual([])
	})

	it("rejects an as assertion to a named type", () => {
		const root = seed({
			"packages/core/src/p.ts": "type Foo = { a: number }\nconst x = {} as Foo\n",
		})
		expect(findViolations(root)).toEqual([
			{ file: "packages/core/src/p.ts", line: 2, token: "assertion" },
		])
	})

	it("rejects an angle-bracket type assertion", () => {
		const root = seed({
			"packages/core/src/q.ts": "type Foo = { a: number }\nconst x = <Foo>{}\n",
		})
		expect(findViolations(root)).toEqual([
			{ file: "packages/core/src/q.ts", line: 2, token: "assertion" },
		])
	})

	it("is clean for a file with no assertions", () => {
		const root = seed({ "packages/core/src/r.ts": "const x = 1\nconst y = x + 1\n" })
		expect(findViolations(root)).toEqual([])
	})

	it("rejects an as-never assertion inside the exhaustive helper, where the never keyword itself is exempt", () => {
		const root = seed({
			"packages/core/src/lib/exhaustive.ts": "const leak = 1 as never\n",
		})
		expect(findViolations(root)).toEqual([
			{ file: "packages/core/src/lib/exhaustive.ts", line: 1, token: "assertion" },
		])
	})

	it("rejects an as-unknown assertion inside the boundary directory, where the unknown keyword itself is exempt", () => {
		const root = seed({
			"packages/contracts/src/boundary/ssh.ts": "const leak = 1 as unknown\n",
		})
		expect(findViolations(root)).toEqual([
			{ file: "packages/contracts/src/boundary/ssh.ts", line: 1, token: "assertion" },
		])
	})

	it("reports exactly one violation, not two, when an as-never assertion coincides with a reported never keyword", () => {
		const root = seed({
			"packages/core/src/s.ts": "const y: never = 1 as never\n",
		})
		const violations = findViolations(root)
		expect(violations).toHaveLength(1)
		expect(violations).toEqual([{ file: "packages/core/src/s.ts", line: 1, token: "never" }])
	})

	it("allows an as const assertion inside both exempt paths", () => {
		const root = seed({
			"packages/core/src/lib/exhaustive.ts": "const ok = 1 as const\n",
			"packages/contracts/src/boundary/t.ts": "const ok2 = 1 as const\n",
		})
		expect(findViolations(root)).toEqual([])
	})

	it("rejects a definite assignment assertion on a variable declaration", () => {
		const root = seed({ "packages/core/src/u.ts": 'let x!: string\nx = "ok"\n' })
		expect(findViolations(root)).toEqual([
			{ file: "packages/core/src/u.ts", line: 1, token: "definite-assignment" },
		])
	})

	it("rejects a definite assignment assertion on a class property declaration", () => {
		const root = seed({
			"packages/core/src/v.ts":
				'class Foo {\n\tfield!: string\n}\nconst f = new Foo()\nf.field = "ok"\n',
		})
		expect(findViolations(root)).toEqual([
			{ file: "packages/core/src/v.ts", line: 2, token: "definite-assignment" },
		])
	})

	it("allows an ordinary initialized variable declaration", () => {
		const root = seed({ "packages/core/src/w.ts": 'let x: string = "a"\n' })
		expect(findViolations(root)).toEqual([])
	})

	it("rejects a ts-expect-error pragma comment", () => {
		const root = seed({
			"packages/core/src/x1.ts": '// @ts-expect-error\nconst n: number = "bad"\n',
		})
		expect(findViolations(root)).toEqual([
			{ file: "packages/core/src/x1.ts", line: 1, token: "@ts-expect-error" },
		])
	})

	it("rejects a ts-ignore pragma comment", () => {
		const root = seed({
			"packages/core/src/x2.ts": '// @ts-ignore\nconst n: number = "bad"\n',
		})
		expect(findViolations(root)).toEqual([
			{ file: "packages/core/src/x2.ts", line: 1, token: "@ts-ignore" },
		])
	})

	it("does not treat the pragma text inside a string literal as a directive", () => {
		const root = seed({
			"packages/core/src/x3.ts": 'const s = "@ts-expect-error"\n',
		})
		expect(findViolations(root)).toEqual([])
	})

	it("does not treat the pragma words in ordinary prose within a non-pragma comment as a directive", () => {
		const root = seed({
			"packages/core/src/x4.ts": "// see @ts-expect-error for reference\nconst n = 1\n",
		})
		expect(findViolations(root)).toEqual([
			{ file: "packages/core/src/x4.ts", line: 1, token: "comment" },
		])
	})

	it("exempts the generated route tree at its real path", () => {
		const root = seed({
			"apps/web/src/routeTree.gen.ts": "const x: unknown = 1\n",
		})
		expect(findViolations(root)).toEqual([])
	})

	it("does not exempt a same-named file outside the generated route tree's path", () => {
		const root = seed({
			"packages/core/src/routeTree.gen.ts": "const x: unknown = 1\n",
		})
		expect(findViolations(root)).toEqual([
			{ file: "packages/core/src/routeTree.gen.ts", line: 1, token: "unknown" },
		])
	})

	it("rejects a ts-expect-error pragma trailing real code on the same line", () => {
		const root = seed({
			"packages/core/src/lease.ts":
				"const LEASE_MS = 300_000 // @ts-expect-error\nexport const isStale = (claimedAt: Date): boolean => claimedAt.nope.deep < LEASE_MS\n",
		})
		expect(findViolations(root)).toEqual([
			{ file: "packages/core/src/lease.ts", line: 1, token: "@ts-expect-error" },
		])
	})

	it("rejects a ts-ignore pragma trailing real code on the same line", () => {
		const root = seed({
			"packages/core/src/y1.ts": "const n = 1 // @ts-ignore\nexport const m = n\n",
		})
		expect(findViolations(root)).toEqual([
			{ file: "packages/core/src/y1.ts", line: 1, token: "@ts-ignore" },
		])
	})

	it("rejects a pragma sitting in trivia between two punctuation tokens", () => {
		const root = seed({
			"packages/core/src/y2.ts":
				"declare const wrap: () => number\nexport const x = wrap(/* @ts-ignore */)\n",
		})
		expect(findViolations(root)).toEqual([
			{ file: "packages/core/src/y2.ts", line: 2, token: "@ts-ignore" },
		])
	})

	it("rejects a jsdoc-delimited pragma", () => {
		const root = seed({
			"packages/core/src/y3.ts": '/** @ts-expect-error */\nconst n: number = "bad"\n',
		})
		expect(findViolations(root)).toEqual([
			{ file: "packages/core/src/y3.ts", line: 1, token: "@ts-expect-error" },
		])
	})

	it("rejects a triple-slash pragma", () => {
		const root = seed({
			"packages/core/src/y4.ts": '/// @ts-expect-error\nconst n: number = "bad"\n',
		})
		expect(findViolations(root)).toEqual([
			{ file: "packages/core/src/y4.ts", line: 1, token: "@ts-expect-error" },
		])
	})

	it("rejects a pragma written with no space after the comment delimiter", () => {
		const root = seed({
			"packages/core/src/y5.ts": '//@ts-ignore\nconst n: number = "bad"\n',
		})
		expect(findViolations(root)).toEqual([
			{ file: "packages/core/src/y5.ts", line: 1, token: "@ts-ignore" },
		])
	})

	it("rejects a pragma on the closing line of a block comment, the line typescript honours", () => {
		const root = seed({
			"packages/core/src/y6.ts": '/* preamble\n * @ts-expect-error */\nconst n: number = "bad"\n',
		})
		expect(findViolations(root)).toEqual([
			{ file: "packages/core/src/y6.ts", line: 2, token: "@ts-expect-error" },
		])
	})

	it("rejects a ts-nocheck pragma", () => {
		const root = seed({
			"packages/core/src/y7.ts": '// @ts-nocheck\nconst n: number = "bad"\n',
		})
		expect(findViolations(root)).toEqual([
			{ file: "packages/core/src/y7.ts", line: 1, token: "@ts-nocheck" },
		])
	})

	it("does not treat pragma text inside a string literal as a comment", () => {
		const root = seed({
			"packages/core/src/y8.ts": 'export const s = "// @ts-expect-error"\n',
		})
		expect(findViolations(root)).toEqual([])
	})

	it("scans mts files", () => {
		const root = seed({
			"packages/core/src/z1.mts": "type Foo = { a: number }\nexport const x = {} as Foo\n",
		})
		expect(findViolations(root)).toEqual([
			{ file: "packages/core/src/z1.mts", line: 2, token: "assertion" },
		])
	})

	it("scans cts files", () => {
		const root = seed({ "packages/core/src/z2.cts": "export const x: unknown = 1\n" })
		expect(findViolations(root)).toEqual([
			{ file: "packages/core/src/z2.cts", line: 1, token: "unknown" },
		])
	})

	it("scans declaration files", () => {
		const root = seed({ "packages/core/src/z3.d.ts": "declare const x: unknown\n" })
		expect(findViolations(root)).toEqual([
			{ file: "packages/core/src/z3.d.ts", line: 1, token: "unknown" },
		])
	})

	it("skips a coverage directory, matching the biome exclusion list", () => {
		const root = seed({ "packages/core/coverage/z4.ts": "const x: unknown = 1\n" })
		expect(findViolations(root)).toEqual([])
	})

	it("skips a build directory, matching the biome exclusion list", () => {
		const root = seed({ "packages/core/build/z5.ts": "const x: unknown = 1\n" })
		expect(findViolations(root)).toEqual([])
	})

	it("skips the repository's own .claude, where its worktrees live, matching the biome exclusion list", () => {
		const root = seed({
			".claude/worktrees/agent/packages/core/src/z9.ts": "const x: unknown = 1\n",
		})
		expect(findViolations(root)).toEqual([])
	})

	it("scans a .claude directory anywhere but the repository root, as biome does", () => {
		const root = seed({ "apps/web/.claude/za.ts": "const x: unknown = 1\n" })
		expect(findViolations(root)).toEqual([
			{ file: "apps/web/.claude/za.ts", line: 1, token: "unknown" },
		])
	})

	it("scans a directory whose name merely begins with an excluded name", () => {
		const root = seed({
			"packages/core/build-scripts/z6.ts": "const x: unknown = 1\n",
			"packages/core/coverage-report/z7.ts": "const y: unknown = 1\n",
		})
		expect(findViolations(root)).toEqual([
			{ file: "packages/core/build-scripts/z6.ts", line: 1, token: "unknown" },
			{ file: "packages/core/coverage-report/z7.ts", line: 1, token: "unknown" },
		])
	})

	it("rejects a code comment on its own line", () => {
		const root = seed({
			"packages/core/src/z8.ts": "// widen the lease before claiming\nexport const n = 1\n",
		})
		expect(findViolations(root)).toEqual([
			{ file: "packages/core/src/z8.ts", line: 1, token: "comment" },
		])
	})

	it("rejects a code comment trailing real code", () => {
		const root = seed({ "packages/core/src/z9.ts": "export const n = 1 // five minutes\n" })
		expect(findViolations(root)).toEqual([
			{ file: "packages/core/src/z9.ts", line: 1, token: "comment" },
		])
	})

	it("allows comments in the generated database types at their real path", () => {
		const root = seed({
			"packages/db/src/generated/database.ts": "/** generated */\nexport const n = 1\n",
		})
		expect(findViolations(root)).toEqual([])
	})

	it("does not allow comments in a same-named file outside the generated database types path", () => {
		const root = seed({
			"packages/core/src/generated/database.ts": "/** generated */\nexport const n = 1\n",
		})
		expect(findViolations(root)).toEqual([
			{ file: "packages/core/src/generated/database.ts", line: 1, token: "comment" },
		])
	})

	it("still enforces the type policy inside the file where comments are allowed", () => {
		const root = seed({
			"packages/db/src/generated/database.ts": "/** generated */\nexport const n: unknown = 1\n",
		})
		expect(findViolations(root)).toEqual([
			{ file: "packages/db/src/generated/database.ts", line: 2, token: "unknown" },
		])
	})

	it("rejects a default import from next", () => {
		const root = seed({
			"apps/web/src/z10.ts": 'import Link from "next/link"\nexport const L = Link\n',
		})
		expect(findViolations(root)).toEqual([{ file: "apps/web/src/z10.ts", line: 1, token: "next" }])
	})

	it("rejects a bare side-effect import of next", () => {
		const root = seed({ "apps/web/src/z11.ts": 'import "next"\n' })
		expect(findViolations(root)).toEqual([{ file: "apps/web/src/z11.ts", line: 1, token: "next" }])
	})

	it("rejects a dynamic import of next", () => {
		const root = seed({
			"apps/web/src/z12.ts": 'export const load = () => import("next/router")\n',
		})
		expect(findViolations(root)).toEqual([{ file: "apps/web/src/z12.ts", line: 1, token: "next" }])
	})

	it("rejects a re-export from next", () => {
		const root = seed({ "apps/web/src/z13.ts": 'export { default } from "next/head"\n' })
		expect(findViolations(root)).toEqual([{ file: "apps/web/src/z13.ts", line: 1, token: "next" }])
	})

	it("allows an import from a package whose name merely begins with next", () => {
		const root = seed({ "apps/web/src/z14.ts": 'import x from "nextra"\nexport const y = x\n' })
		expect(findViolations(root)).toEqual([])
	})

	it("rejects a next dependency declared in a package manifest", () => {
		const root = seed({
			"apps/web/package.json":
				'{\n\t"name": "@open-mcc/web",\n\t"dependencies": {\n\t\t"next": "^15.0.0"\n\t}\n}\n',
		})
		expect(findViolations(root)).toEqual([
			{ file: "apps/web/package.json", line: 4, token: "next" },
		])
	})

	it("rejects a scoped next package declared in a manifest's devDependencies", () => {
		const root = seed({
			"apps/web/package.json":
				'{\n\t"name": "@open-mcc/web",\n\t"devDependencies": {\n\t\t"@next/env": "^15.0.0"\n\t}\n}\n',
		})
		expect(findViolations(root)).toEqual([
			{ file: "apps/web/package.json", line: 4, token: "next" },
		])
	})

	it("allows a manifest whose dependency names merely begin with next", () => {
		const root = seed({
			"apps/web/package.json":
				'{\n\t"name": "@open-mcc/web",\n\t"dependencies": {\n\t\t"next-tick": "^1.1.0",\n\t\t"nextra": "^2.13.4"\n\t}\n}\n',
		})
		expect(findViolations(root)).toEqual([])
	})

	it("reports a malformed manifest as a parse error", () => {
		const root = seed({ "apps/web/package.json": '{\n\t"name": "@open-mcc/web",\n' })
		expect(findViolations(root)).toEqual([
			{ file: "apps/web/package.json", line: 1, token: "parse-error" },
		])
	})

	it("reports source violations before manifest violations", () => {
		const root = seed({
			"apps/web/package.json": '{\n\t"dependencies": {\n\t\t"next": "^15.0.0"\n\t}\n}\n',
			"apps/web/src/z15.ts": 'import Link from "next/link"\nexport const L = Link\n',
		})
		expect(findViolations(root)).toEqual([
			{ file: "apps/web/src/z15.ts", line: 1, token: "next" },
			{ file: "apps/web/package.json", line: 3, token: "next" },
		])
	})
})

describe("the command pnpm lint runs", () => {
	const BYPASS = { "packages/core/src/a.ts": "const x: unknown = 1\n" }

	it("exits 1 and names the token it found in the tree it was pointed at", () => {
		const result = spawnSync("node", [CHECKER], { cwd: seed(BYPASS), encoding: "utf8" })

		expect(result.status).toBe(1)
		expect(`${result.stdout}${result.stderr}`).toContain(
			`${join("packages", "core", "src", "a.ts")}:1 forbidden token 'unknown'`,
		)
	})

	it("still runs from a path holding a space, rather than passing without checking", () => {
		const directory = scratch("a gate-")
		const copied = join(directory, "check-type-policy.mjs")
		copyFileSync(CHECKER, copied)
		symlinkSync(join(ROOT, "node_modules"), join(directory, "node_modules"), "dir")

		const result = spawnSync("node", [copied], { cwd: seed(BYPASS), encoding: "utf8" })

		expect(result.status).toBe(1)
		expect(`${result.stdout}${result.stderr}`).toContain(
			`${join("packages", "core", "src", "a.ts")}:1 forbidden token 'unknown'`,
		)
	})

	it("exits 0 from that same path on a tree with nothing to report, so it is not simply failing", () => {
		const directory = scratch("a gate-")
		const copied = join(directory, "check-type-policy.mjs")
		copyFileSync(CHECKER, copied)
		symlinkSync(join(ROOT, "node_modules"), join(directory, "node_modules"), "dir")
		const clean = seed({ "packages/core/src/a.ts": "export const x = 1 as const\n" })

		const result = spawnSync("node", [copied], { cwd: clean, encoding: "utf8" })

		expect(`${result.stdout}${result.stderr}`).toBe("")
		expect(result.status).toBe(0)
	})
})
