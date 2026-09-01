import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { UNIT_TEMPLATE } from "./unit-template"

const REPOSITORY_TEMPLATE = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
	"..",
	"..",
	"docker",
	"systemd",
	"open-mcc@.service",
)

describe("embedded systemd unit template", () => {
	it("is byte-identical to the unit file in the repository, so the two cannot drift", () => {
		expect(UNIT_TEMPLATE).toBe(readFileSync(REPOSITORY_TEMPLATE, "utf8"))
	})

	it("is embedded rather than read at runtime, so a bundled server has no file dependency", () => {
		expect(UNIT_TEMPLATE.length).toBeGreaterThan(0)
		expect(UNIT_TEMPLATE).toContain("User=mcc-%i")
		expect(UNIT_TEMPLATE).toContain("RestartPreventExitStatus=4")
	})
})
