import { describe, expect, it } from "vitest"
import {
	AUTH_UNIT_NAME,
	INSTANCE_UNIT_NAME,
	renderUnitTemplates,
	SLEEP_START_UNIT_NAME,
	SLEEP_STOP_UNIT_NAME,
} from "./unit-template"

const units = renderUnitTemplates()
const instance = units[INSTANCE_UNIT_NAME] ?? ""
const signIn = units[AUTH_UNIT_NAME] ?? ""
const DIR = "%h/.local/share/open-mcc/instances/%i"

describe("the units every host runs", () => {
	it("names no user or group, and never hides the whole home, because the connecting account runs every bot", () => {
		for (const template of Object.values(units)) {
			expect(template).not.toContain("User=")
			expect(template).not.toContain("Group=")
			expect(template).not.toContain("ProtectHome=yes")
		}
	})

	it("spells every path from the account's home with %h, so no path is stored or guessed", () => {
		for (const template of Object.values(units)) {
			const paths = template.match(/[^\s'"=]*\.local\/share\/open-mcc[^\s'"]*/g) ?? []
			for (const path of paths) expect(path.startsWith("%h/")).toBe(true)
			expect(template).not.toContain("/srv/open-mcc")
			expect(template).not.toContain("/home/")
		}
		expect(instance).toContain(`WorkingDirectory=${DIR}`)
		expect(signIn).toContain(`WorkingDirectory=${DIR}`)
	})

	it("keeps the start rate limit in the section systemd reads it from", () => {
		const unitSection = instance.slice(0, instance.indexOf("[Service]"))
		expect(unitSection).toContain("StartLimitIntervalSec=600")
		expect(unitSection).toContain("StartLimitBurst=5")
		expect(instance.slice(instance.indexOf("[Service]"))).not.toContain("StartLimit")
	})

	it("keeps the watchdog policy that stops a doomed client from restarting forever", () => {
		expect(instance).toContain("RestartPreventExitStatus=4")
	})

	it("keeps the hardening that does not require privilege", () => {
		for (const directive of ["NoNewPrivileges=yes", "UMask=0077", "ProtectSystem=strict"]) {
			expect(instance).toContain(directive)
		}
	})

	it("enables against a target the user manager actually has", () => {
		expect(instance).toContain("WantedBy=default.target")
	})

	it("drives its sleep units through the user manager", () => {
		expect(units[SLEEP_STOP_UNIT_NAME]).toContain(
			"ExecStart=/usr/bin/systemctl --user stop open-mcc@%i.service",
		)
		expect(units[SLEEP_START_UNIT_NAME]).toContain(
			"ExecStart=/usr/bin/systemctl --user start open-mcc@%i.service",
		)
	})

	it("holds the control channel open for writing, so the client is not blocked at startup waiting for one", () => {
		expect(instance).toContain(`exec 3<>"${DIR}/control"`)
		expect(instance).toContain("<&3")
	})

	it("does not take stdin straight from the fifo, which blocks until a writer appears", () => {
		expect(instance).not.toContain("StandardInput=file:")
	})

	it("still routes the console to journald, which is how the manager reads it", () => {
		expect(instance).toContain("StandardOutput=journal")
		expect(instance).toContain("StandardError=journal")
	})
})

describe("the unit that signs an instance in to Microsoft", () => {
	it("exists, so sign-in is never an unsupervised process", () => {
		expect(units[AUTH_UNIT_NAME]).toBeDefined()
	})

	it("carries the same confinement as the instance it signs in", () => {
		for (const directive of [
			"ProtectSystem=strict",
			"NoNewPrivileges=yes",
			"PrivateTmp=yes",
			`ReadWritePaths=${DIR}`,
		]) {
			expect(signIn).toContain(directive)
		}
	})

	it("takes no input, since a sign-in has nothing to read", () => {
		expect(signIn).toContain("StandardInput=null")
	})

	it("never restarts, because a sign-in is a single attempt an operator is watching", () => {
		expect(signIn).not.toContain("Restart=")
	})

	it("is started on demand rather than enabled at boot", () => {
		expect(signIn).not.toContain("[Install]")
	})
})

describe("keeping instances out of each other's files", () => {
	it("hides the home directory and binds back only the instance's own, in every unit that runs the client", () => {
		for (const template of [instance, signIn]) {
			expect(template).toContain("ProtectHome=tmpfs")
			expect(template).toContain(`BindPaths=${DIR}`)
		}
	})

	it("binds the client read-only, since an instance has no reason to rewrite it", () => {
		expect(instance).toContain("BindReadOnlyPaths=%h/.local/share/open-mcc/bin")
	})
})

describe("stopping an instance", () => {
	it("asks a running client to quit within five seconds, then waits for it to exit", () => {
		const stop = /^ExecStop=.*$/m.exec(instance)?.[0]

		expect(stop).toBe(
			`ExecStop=/bin/sh -c '[ -z "$$MAINPID" ] || { timeout 5 sh -c "echo /quit > ${DIR}/control" && while kill -0 $$MAINPID 2>/dev/null; do sleep 1; done; }'`,
		)
	})
})
