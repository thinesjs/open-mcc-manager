import { LINGER_STEP_LABEL, PROVISION_STEP_LABELS } from "@open-mcc/contracts"
import { describe, expect, it } from "vitest"
import * as provision from "./provision"
import { PROVISION_STEPS } from "./provision"

describe("the provisioning plan", () => {
	it("is the same list the dashboard renders, in the same order", () => {
		expect([...PROVISION_STEPS]).toEqual([...PROVISION_STEP_LABELS])
	})

	it("is the fifteen steps a Podman host is set up with, in order", () => {
		expect([...PROVISION_STEP_LABELS]).toEqual([
			"Checking systemd",
			"Checking that instances survive a logout",
			"Checking Podman",
			"Setting up container storage",
			"Creating the instances directory",
			"Reading the host architecture",
			"Downloading the client",
			"Verifying the download",
			"Installing the client",
			"Downloading the runtime image",
			"Verifying the runtime image",
			"Checking the client runs",
			"Installing the instance unit",
			"Installing the sleep units",
			"Reloading systemd",
		])
	})

	it("is one list for every host, checking lingering and never checking confinement", () => {
		expect(PROVISION_STEPS).toContain(LINGER_STEP_LABEL)
		expect(PROVISION_STEPS).not.toContain("Checking that instances are confined")
		expect(Object.keys(provision)).not.toContain("ROOTLESS_PROVISION_STEPS")
	})

	it("keeps verification between the download and the install, which is the whole point", () => {
		const download = PROVISION_STEPS.indexOf("Downloading the client")
		const verify = PROVISION_STEPS.indexOf("Verifying the download")
		const install = PROVISION_STEPS.indexOf("Installing the client")
		expect(download).toBeLessThan(verify)
		expect(verify).toBeLessThan(install)
	})

	it("sets up storage before any step that starts Podman, and checks the image before running it", () => {
		const storage = PROVISION_STEPS.indexOf("Setting up container storage")
		const pull = PROVISION_STEPS.indexOf("Downloading the runtime image")
		const verify = PROVISION_STEPS.indexOf("Verifying the runtime image")
		const runs = PROVISION_STEPS.indexOf("Checking the client runs")
		expect(PROVISION_STEPS.indexOf("Checking Podman")).toBeLessThan(storage)
		expect(storage).toBeLessThan(pull)
		expect(pull).toBeLessThan(verify)
		expect(verify).toBeLessThan(runs)
		expect(PROVISION_STEPS.indexOf("Installing the client")).toBeLessThan(runs)
	})
})
