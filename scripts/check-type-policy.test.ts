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
})
