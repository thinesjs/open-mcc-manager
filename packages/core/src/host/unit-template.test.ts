import { readdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { rootlessProfile, systemProfile } from "./profile"
import { AUTH_UNIT_NAME, INSTANCE_UNIT_NAME, renderUnitTemplates } from "./unit-template"

const SYSTEMD_DIR = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
	"..",
	"..",
	"docker",
	"systemd",
)

const system = renderUnitTemplates(systemProfile())
const rootless = renderUnitTemplates(rootlessProfile("/home/mccuser"))

describe("the units a root-owned host runs", () => {
	it("covers every unit file the repository ships, so none is silently left behind", () => {
		expect(Object.keys(system).sort()).toEqual(readdirSync(SYSTEMD_DIR).sort())
	})

	it("is byte-identical to each shipped unit file, so the two cannot drift", () => {
		for (const [name, rendered] of Object.entries(system)) {
			expect(rendered).toBe(readFileSync(join(SYSTEMD_DIR, name), "utf8"))
		}
	})

	it("keeps the start rate limit in the section systemd reads it from", () => {
		const template = system[INSTANCE_UNIT_NAME] ?? ""
		const unitSection = template.slice(0, template.indexOf("[Service]"))
		expect(unitSection).toContain("StartLimitIntervalSec=600")
		expect(unitSection).toContain("StartLimitBurst=5")
		expect(template.slice(template.indexOf("[Service]"))).not.toContain("StartLimit")
	})
})

describe("the units a host without root runs", () => {
	it("names no user, because the manager cannot create one", () => {
		const template = rootless[INSTANCE_UNIT_NAME] ?? ""
		expect(template).not.toContain("User=")
		expect(template).not.toContain("Group=")
	})

	it("hides the home directory its files live in, but binds its own directory back", () => {
		const template = rootless[INSTANCE_UNIT_NAME] ?? ""
		const dir = "/home/mccuser/.local/share/open-mcc/instances/%i"

		expect(template).toContain("ProtectHome=tmpfs")
		expect(template).toContain(`BindPaths=${dir}`)
		expect(template).toContain(`WorkingDirectory=${dir}`)
		expect(system[INSTANCE_UNIT_NAME]).toContain("ProtectHome=yes")
	})

	it("keeps the watchdog policy that stops a doomed client from restarting forever", () => {
		expect(rootless[INSTANCE_UNIT_NAME]).toContain("RestartPreventExitStatus=4")
	})

	it("keeps the hardening that does not require privilege", () => {
		for (const directive of ["NoNewPrivileges=yes", "UMask=0077", "ProtectSystem=strict"]) {
			expect(rootless[INSTANCE_UNIT_NAME]).toContain(directive)
		}
	})

	it("enables against a target the user manager actually has", () => {
		expect(rootless[INSTANCE_UNIT_NAME]).toContain("WantedBy=default.target")
		expect(system[INSTANCE_UNIT_NAME]).toContain("WantedBy=multi-user.target")
	})

	it("keeps every path inside the user's own home", () => {
		const template = rootless[INSTANCE_UNIT_NAME] ?? ""
		expect(template).not.toContain("/srv/open-mcc")
		expect(template).toContain("/home/mccuser/.local/share/open-mcc/instances/%i")
	})

	it("drives its sleep units through the user manager", () => {
		expect(rootless["open-mcc-sleep-stop@.service"]).toContain(
			"systemctl --user stop open-mcc@%i.service",
		)
		expect(rootless["open-mcc-sleep-start@.service"]).toContain(
			"systemctl --user start open-mcc@%i.service",
		)
	})
})

describe("the units both modes run", () => {
	it("holds the control channel open for writing, so the client is not blocked at startup waiting for one", () => {
		for (const template of [system[INSTANCE_UNIT_NAME] ?? "", rootless[INSTANCE_UNIT_NAME] ?? ""]) {
			expect(template).toContain("exec 3<>")
			expect(template).toContain("<&3")
		}
	})

	it("does not take stdin straight from the fifo, which blocks until a writer appears", () => {
		for (const template of [system[INSTANCE_UNIT_NAME] ?? "", rootless[INSTANCE_UNIT_NAME] ?? ""]) {
			expect(template).not.toContain("StandardInput=file:")
		}
	})

	it("still routes the console to journald, which is how the manager reads it", () => {
		for (const template of [system[INSTANCE_UNIT_NAME] ?? "", rootless[INSTANCE_UNIT_NAME] ?? ""]) {
			expect(template).toContain("StandardOutput=journal")
			expect(template).toContain("StandardError=journal")
		}
	})

	it("drives the sleep units through systemctl on the instance's own unit", () => {
		expect(system["open-mcc-sleep-stop@.service"]).toContain("systemctl stop open-mcc@%i.service")
		expect(system["open-mcc-sleep-start@.service"]).toContain("systemctl start open-mcc@%i.service")
	})
})

describe("the unit that signs an instance in to Microsoft", () => {
	it("exists in both modes, so sign-in is never an unsupervised process", () => {
		expect(system[AUTH_UNIT_NAME]).toBeDefined()
		expect(rootless[AUTH_UNIT_NAME]).toBeDefined()
	})

	it("carries the same confinement as the instance it signs in", () => {
		for (const template of [system[AUTH_UNIT_NAME] ?? "", rootless[AUTH_UNIT_NAME] ?? ""]) {
			expect(template).toContain("ProtectSystem=strict")
			expect(template).toContain("NoNewPrivileges=yes")
			expect(template).toContain("PrivateTmp=yes")
			expect(template).toContain("ReadWritePaths=")
		}
	})

	it("runs as the instance's own account wherever there is one", () => {
		expect(system[AUTH_UNIT_NAME]).toContain("User=mcc-%i")
		expect(rootless[AUTH_UNIT_NAME]).not.toContain("User=")
	})

	it("takes no input, since a sign-in has nothing to read", () => {
		expect(system[AUTH_UNIT_NAME]).toContain("StandardInput=null")
	})

	it("never restarts, because a sign-in is a single attempt an operator is watching", () => {
		expect(system[AUTH_UNIT_NAME]).not.toContain("Restart=")
	})

	it("is started on demand rather than enabled at boot", () => {
		expect(system[AUTH_UNIT_NAME]).not.toContain("[Install]")
	})
})

describe("keeping rootless instances out of each other's files", () => {
	const rootlessUnits = [AUTH_UNIT_NAME, INSTANCE_UNIT_NAME]

	it("hides the home directory and binds back only the instance's own, in every rootless unit", () => {
		for (const name of rootlessUnits) {
			const template = rootless[name] ?? ""
			expect(template).toContain("ProtectHome=tmpfs")
			expect(template).toContain("BindPaths=/home/mccuser/.local/share/open-mcc/instances/%i")
		}
	})

	it("binds the client read-only, since an instance has no reason to rewrite it", () => {
		expect(rootless[INSTANCE_UNIT_NAME]).toContain(
			"BindReadOnlyPaths=/home/mccuser/.local/share/open-mcc/bin",
		)
	})

	it("leaves a root-owned host to its per-instance accounts instead", () => {
		for (const name of rootlessUnits) {
			expect(system[name]).not.toContain("BindPaths=")
			expect(system[name]).toContain("ProtectHome=yes")
		}
	})
})
