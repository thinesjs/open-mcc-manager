import { describe, expect, it } from "vitest"
import {
	bundledPackages,
	groupByText,
	packageAt,
	render,
	unattributed,
} from "../docker/third-party-notices.mjs"

const entry = (name: string, licence: string, text: string) => ({
	name,
	version: "1.0.0",
	licence,
	text,
})

describe("locating the package an esbuild input belongs to", () => {
	it("reads through the pnpm virtual store to the owning package", () => {
		expect(
			packageAt("node_modules/.pnpm/smol-toml@1.8.0/node_modules/smol-toml/dist/parse.js"),
		).toEqual({
			name: "smol-toml",
			dir: "node_modules/.pnpm/smol-toml@1.8.0/node_modules/smol-toml",
		})
	})

	it("keeps both halves of a scoped name", () => {
		expect(
			packageAt(
				"node_modules/.pnpm/@opentelemetry+core@2.11.0/node_modules/@opentelemetry/core/x.js",
			)?.name,
		).toBe("@opentelemetry/core")
	})

	it("treats a workspace source file as this repository's own", () => {
		expect(packageAt("packages/core/src/index.ts")).toBe(null)
	})
})

describe("reading what esbuild folded into the bundle", () => {
	it("names every third-party package behind the inputs", () => {
		const metafile = JSON.stringify({
			inputs: {
				"apps/server/src/index.ts": {},
				"node_modules/.pnpm/zod@3.25.76/node_modules/zod/lib/a.js": {},
				"node_modules/.pnpm/zod@3.25.76/node_modules/zod/lib/b.js": {},
			},
		})
		expect([...bundledPackages(metafile).keys()]).toEqual(["zod"])
	})
})

describe("catching a package the image would ship with no attribution", () => {
	it("names a package carrying neither a licence text nor a declared licence", () => {
		expect(unattributed([entry("mystery", "", "")])).toEqual(["mystery 1.0.0"])
	})

	it("accepts a declared licence when upstream publishes no text", () => {
		expect(unattributed([entry("pgpass", "MIT", "")])).toEqual([])
	})

	it("accepts a licence text when the manifest declares nothing", () => {
		expect(unattributed([entry("ssh2", "", "the ssh2 licence")])).toEqual([])
	})
})

describe("printing one copy of a text many packages share", () => {
	it("gathers the packages that carry identical texts", () => {
		const groups = groupByText([
			entry("first", "Apache-2.0", "the same text"),
			entry("second", "Apache-2.0", "the same text"),
			entry("third", "MIT", "another text"),
		])
		expect(groups.length).toBe(2)
		expect(groups[0]?.text).toBe("the same text")
		expect(groups[0]?.members.length).toBe(2)
		expect(groups[1]?.members.length).toBe(1)
	})

	it("drops a package that carries no text, leaving it to the declared-only section", () => {
		expect(groupByText([entry("pgpass", "MIT", "")]).length).toBe(0)
	})
})

describe("the rendered bundle", () => {
	it("prints a shared text once and records the packages that have none", () => {
		const output = render([
			entry("second", "Apache-2.0", "the same text"),
			entry("first", "Apache-2.0", "the same text"),
			entry("pgpass", "MIT", ""),
		])
		expect(output.split("the same text").length - 1).toBe(1)
		expect(output.indexOf("first 1.0.0")).toBeLessThan(output.indexOf("second 1.0.0"))
		expect(output).toContain("pgpass 1.0.0 — MIT")
	})

	it("leaves out the declared-only section when every package carries a text", () => {
		expect(render([entry("first", "MIT", "a text")])).not.toContain(
			"Packages that publish no licence file of their own",
		)
	})
})
