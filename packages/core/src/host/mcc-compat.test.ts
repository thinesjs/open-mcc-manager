import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { MCC_VERSION } from "./mcc-release"

const AUDIT_SURFACES = [
	"Key registry",
	"Config drift",
	"Renderer",
	"Bot capabilities",
	"Live control",
	"Journal and exit signals",
] as const

const here = dirname(fileURLToPath(import.meta.url))

const ledger = readFileSync(join(here, "..", "..", "..", "..", "docs", "mcc-compat.md"), "utf8")

const fixture = readFileSync(
	join(here, "..", "..", "..", "contracts", "src", "boundary", "mcc-config-fixture.ini"),
	"utf8",
)

const entries = ledger
	.split(/^### /m)
	.slice(1)
	.map((block) => {
		const heading = block.indexOf("\n")
		return {
			version: block.slice(0, heading === -1 ? block.length : heading).trim(),
			body: heading === -1 ? "" : block.slice(heading + 1),
		}
	})

const newest = entries[0]

const findings = new Map(
	[...(newest?.body ?? "").matchAll(/^- ([^:\n]+):([\s\S]*?)(?=^- |(?![\s\S]))/gm)].map((match) => [
		match[1] ?? "",
		(match[2] ?? "").trim(),
	]),
)

const [, build = ""] = MCC_VERSION.split("-")
const capturedFrom = fixture.match(/^"Current Version" = "(.*)"$/m)?.[1] ?? ""

describe("docs/mcc-compat.md", () => {
	it("records an audit for the build every host installs", () => {
		expect(newest?.version).toBe(MCC_VERSION)
	})

	it("says what that audit found on every surface a bump moves silently", () => {
		expect(AUDIT_SURFACES.filter((surface) => (findings.get(surface) ?? "").length === 0)).toEqual(
			[],
		)
	})
})

describe("mcc-config-fixture.ini", () => {
	it("was captured from the build every host installs, not an older one", () => {
		expect(capturedFrom).toContain(`build ${build}`)
	})
})
