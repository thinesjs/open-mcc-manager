import { readdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { UNIT_TEMPLATE, UNIT_TEMPLATES } from "./unit-template"

const SYSTEMD_DIR = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
	"..",
	"..",
	"docker",
	"systemd",
)

describe("embedded systemd unit templates", () => {
	it("embeds every unit file the repository ships, so none is silently left behind", () => {
		expect(Object.keys(UNIT_TEMPLATES).sort()).toEqual(readdirSync(SYSTEMD_DIR).sort())
	})

	it("is byte-identical to each unit file, so the two cannot drift", () => {
		for (const [name, embedded] of Object.entries(UNIT_TEMPLATES)) {
			expect(embedded).toBe(readFileSync(join(SYSTEMD_DIR, name), "utf8"))
		}
	})

	it("is embedded rather than read at runtime, so a bundled server has no file dependency", () => {
		expect(UNIT_TEMPLATE).toContain("User=mcc-%i")
		expect(UNIT_TEMPLATE).toContain("RestartPreventExitStatus=4")
	})

	it("keeps the start rate limit in the section systemd reads it from", () => {
		const template = UNIT_TEMPLATES["open-mcc@.service"] ?? ""
		const unitSection = template.slice(0, template.indexOf("[Service]"))
		expect(unitSection).toContain("StartLimitIntervalSec=600")
		expect(unitSection).toContain("StartLimitBurst=5")
		expect(template.slice(template.indexOf("[Service]"))).not.toContain("StartLimit")
	})

	it("drives the sleep units through systemctl on the instance's own unit", () => {
		expect(UNIT_TEMPLATES["open-mcc-sleep-stop@.service"]).toContain(
			"systemctl stop open-mcc@%i.service",
		)
		expect(UNIT_TEMPLATES["open-mcc-sleep-start@.service"]).toContain(
			"systemctl start open-mcc@%i.service",
		)
	})
})
