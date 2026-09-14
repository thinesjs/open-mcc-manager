import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it } from "vitest"
import {
	bundledPackages,
	groupByText,
	packageAt,
	render,
	unattributed,
} from "../docker/third-party-notices.mjs"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const GENERATOR = join(ROOT, "docker", "third-party-notices.mjs")

const temporaries: string[] = []

const scratch = (): string => {
	const made = mkdtempSync(join(tmpdir(), "third-party-notices-"))
	temporaries.push(made)
	return made
}

afterEach(() => {
	for (const made of temporaries.splice(0)) rmSync(made, { force: true, recursive: true })
})

const writePackage = (dir: string, name: string, version: string, licenceText?: string) => {
	mkdirSync(dir, { recursive: true })
	writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version, license: "MIT" }))
	if (licenceText !== undefined) writeFileSync(join(dir, "LICENSE"), licenceText)
}

const writeManifest = (dir: string, manifest: Record<string, string>, licenceText?: string) => {
	mkdirSync(dir, { recursive: true })
	writeFileSync(join(dir, "package.json"), JSON.stringify(manifest))
	if (licenceText !== undefined) writeFileSync(join(dir, "LICENSE"), licenceText)
}

const writeMetafile = (path: string, inputs: string[]) => {
	const object: Record<string, object> = {}
	for (const input of inputs) object[input] = {}
	writeFileSync(path, JSON.stringify({ inputs: object }))
}

const runGenerator = (
	installRoot: string,
	deployRoot: string,
	outFile: string,
	metafiles: string[] = [],
) =>
	spawnSync("node", [GENERATOR, installRoot, deployRoot, outFile, ...metafiles], {
		encoding: "utf8",
	})

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

describe("generating notices against a real deployed tree", () => {
	it("records both versions when a bundled package appears twice in the metafile inputs", () => {
		const installRoot = scratch()
		const deployRoot = scratch()
		const outFile = join(scratch(), "NOTICES.txt")
		const metafile = join(scratch(), "meta.json")

		writePackage(
			join(installRoot, "node_modules/.pnpm/left-pad@1.0.0/node_modules/left-pad"),
			"left-pad",
			"1.0.0",
			"left-pad licence text v1",
		)
		writePackage(
			join(installRoot, "node_modules/.pnpm/left-pad@2.0.0/node_modules/left-pad"),
			"left-pad",
			"2.0.0",
			"left-pad licence text v2",
		)
		writeMetafile(metafile, [
			"node_modules/.pnpm/left-pad@1.0.0/node_modules/left-pad/index.js",
			"node_modules/.pnpm/left-pad@2.0.0/node_modules/left-pad/index.js",
		])

		const result = runGenerator(installRoot, deployRoot, outFile, [metafile])
		expect(result.status).toBe(0)
		const written = readFileSync(outFile, "utf8")
		expect(written).toContain("left-pad 1.0.0")
		expect(written).toContain("left-pad 2.0.0")
	})

	it("descends into a nested node_modules of a deployed package", () => {
		const installRoot = scratch()
		const deployRoot = scratch()
		const outFile = join(scratch(), "NOTICES.txt")

		writePackage(join(deployRoot, "node_modules/a"), "a", "1.0.0", "a licence text")
		writePackage(join(deployRoot, "node_modules/a/node_modules/b"), "b", "1.0.0", "b licence text")

		const result = runGenerator(installRoot, deployRoot, outFile)
		expect(result.status).toBe(0)
		const written = readFileSync(outFile, "utf8")
		expect(written).toContain("b 1.0.0")
	})

	it("prints one entry when a bundled input and a shipped directory name the same package at the same version", () => {
		const installRoot = scratch()
		const deployRoot = scratch()
		const outFile = join(scratch(), "NOTICES.txt")
		const metafile = join(scratch(), "meta.json")

		writePackage(
			join(installRoot, "node_modules/.pnpm/shared@1.2.3/node_modules/shared"),
			"shared",
			"1.2.3",
			"shared licence text",
		)
		writePackage(join(deployRoot, "node_modules/shared"), "shared", "1.2.3", "shared licence text")
		writeMetafile(metafile, ["node_modules/.pnpm/shared@1.2.3/node_modules/shared/index.js"])

		const result = runGenerator(installRoot, deployRoot, outFile, [metafile])
		expect(result.status).toBe(0)
		expect(result.stdout).toContain("wrote 1 third-party notices")
		const written = readFileSync(outFile, "utf8")
		expect(written.split("shared 1.2.3").length - 1).toBe(1)
	})

	it("keeps a different licence text for each version of the same shipped package", () => {
		const installRoot = scratch()
		const deployRoot = scratch()
		const outFile = join(scratch(), "NOTICES.txt")

		writePackage(join(deployRoot, "node_modules/left-pad"), "left-pad", "1.0.0", "top level text")
		writePackage(
			join(deployRoot, "node_modules/holder/node_modules/left-pad"),
			"left-pad",
			"2.0.0",
			"nested different text",
		)
		writePackage(join(deployRoot, "node_modules/holder"), "holder", "1.0.0", "holder licence")

		const result = runGenerator(installRoot, deployRoot, outFile)
		expect(result.status).toBe(0)
		const written = readFileSync(outFile, "utf8")
		expect(written).toContain("top level text")
		expect(written).toContain("nested different text")
	})

	it("refuses a version with no licence even when another version of the same name is attributed", () => {
		const installRoot = scratch()
		const deployRoot = scratch()
		const outFile = join(scratch(), "NOTICES.txt")

		writePackage(join(deployRoot, "node_modules/left-pad"), "left-pad", "1.0.0", "top level text")
		mkdirSync(join(deployRoot, "node_modules/holder/node_modules/left-pad"), { recursive: true })
		writeFileSync(
			join(deployRoot, "node_modules/holder/node_modules/left-pad/package.json"),
			JSON.stringify({ name: "left-pad", version: "2.0.0" }),
		)
		writePackage(join(deployRoot, "node_modules/holder"), "holder", "1.0.0", "holder licence")

		const result = runGenerator(installRoot, deployRoot, outFile)
		expect(result.status).not.toBe(0)
		expect(result.stdout).toContain("left-pad 2.0.0")
	})
})

describe("symlinked packages in the deployed tree", () => {
	it("attributes a symlinked package at its realpath-resolved directory", () => {
		const installRoot = scratch()
		const deployRoot = scratch()
		const outFile = join(scratch(), "NOTICES.txt")

		const realDir = join(deployRoot, "node_modules/.store/real-target")
		writePackage(realDir, "real-target", "1.0.0", "resolved licence text")
		symlinkSync(realDir, join(deployRoot, "node_modules/linked-alias"), "dir")

		const result = runGenerator(installRoot, deployRoot, outFile)
		expect(result.status).toBe(0)
		const written = readFileSync(outFile, "utf8")
		expect(written).toContain("resolved licence text")
		expect(written).toContain("1.0.0")
	})

	it("fails loudly when a symlinked package resolves outside the deployed tree", () => {
		const installRoot = scratch()
		const outerRoot = scratch()
		const deployRoot = join(outerRoot, "deploy")
		const outsideDir = join(outerRoot, "elsewhere", "linked-pkg")
		const outFile = join(scratch(), "NOTICES.txt")

		writePackage(outsideDir, "linked-pkg", "1.0.0", "outside licence text")
		writePackage(
			join(deployRoot, "node_modules/real-pkg"),
			"real-pkg",
			"1.0.0",
			"inside licence text",
		)
		symlinkSync(outsideDir, join(deployRoot, "node_modules/linked-pkg"), "dir")

		const result = runGenerator(installRoot, deployRoot, outFile)
		expect(result.status).not.toBe(0)
		expect(result.stdout).toContain("escapes the deployed tree")
	})

	it("terminates a symlink cycle and records a revisited package once", () => {
		const installRoot = scratch()
		const deployRoot = scratch()
		const outFile = join(scratch(), "NOTICES.txt")

		const cycDir = join(deployRoot, "node_modules/cyc")
		writePackage(cycDir, "cyc", "1.0.0", "cyc licence text")
		mkdirSync(join(cycDir, "node_modules"), { recursive: true })
		symlinkSync(cycDir, join(cycDir, "node_modules/cyc-self"), "dir")
		symlinkSync(cycDir, join(deployRoot, "node_modules/alias-to-cyc"), "dir")

		const started = Date.now()
		const result = runGenerator(installRoot, deployRoot, outFile)
		expect(Date.now() - started).toBeLessThan(5000)
		expect(result.status).toBe(0)
		const written = readFileSync(outFile, "utf8")
		expect(written.split("cyc licence text").length - 1).toBe(1)
	})
})

describe("version-less packages in the deployed tree", () => {
	it("keeps two version-less packages with different licence texts distinct", () => {
		const installRoot = scratch()
		const deployRoot = scratch()
		const outFile = join(scratch(), "NOTICES.txt")

		writeManifest(
			join(deployRoot, "node_modules/widget"),
			{ name: "widget", license: "MIT" },
			"TEXT-A",
		)
		writeManifest(
			join(deployRoot, "node_modules/holder/node_modules/widget"),
			{ name: "widget", license: "MIT" },
			"TEXT-B",
		)
		writePackage(join(deployRoot, "node_modules/holder"), "holder", "1.0.0", "holder licence")

		const result = runGenerator(installRoot, deployRoot, outFile)
		expect(result.status).toBe(0)
		const written = readFileSync(outFile, "utf8")
		expect(written).toContain("TEXT-A")
		expect(written).toContain("TEXT-B")
	})
})
