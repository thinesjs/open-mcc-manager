import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { findViolations } from "./check-type-policy.mjs"

const seed = (files: Record<string, string>): string => {
	const root = mkdtempSync(join(tmpdir(), "policy-"))
	for (const [rel, body] of Object.entries(files)) {
		const full = join(root, rel)
		mkdirSync(join(full, ".."), { recursive: true })
		writeFileSync(full, body)
	}
	return root
}

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

	it("ignores tokens inside comments", () => {
		const root = seed({
			"packages/core/src/e.ts": "// this function should never return unknown\n",
		})
		expect(findViolations(root)).toEqual([])
	})

	it("detects violations hidden by url-like patterns in block comments", () => {
		const root = seed({
			"packages/core/src/f.ts": "/* see http://example.com */ const leak: unknown = 1\n",
			"packages/core/src/g.ts": "/* docs http://x.io/spec */ const leak2: never = 1 as never\n",
		})
		expect(findViolations(root)).toEqual([
			{ file: "packages/core/src/f.ts", line: 1, token: "unknown" },
			{ file: "packages/core/src/g.ts", line: 1, token: "never" },
		])
	})

	it("ignores tokens inside multi-line block comments", () => {
		const root = seed({
			"packages/core/src/h.ts": "/*\n * never returns unknown\n */\nexport const ok = 1\n",
		})
		expect(findViolations(root)).toEqual([])
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
		expect(findViolations(root)).toEqual([])
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
})
