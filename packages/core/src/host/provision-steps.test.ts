import { PROVISION_STEP_LABELS } from "@open-mcc/contracts"
import { describe, expect, it } from "vitest"
import { PROVISION_STEPS } from "./provision"

describe("the provisioning plan", () => {
	it("is the same list the dashboard renders, in the same order", () => {
		expect([...PROVISION_STEPS]).toEqual([...PROVISION_STEP_LABELS])
	})

	it("reports the download, its verification and its installation separately", () => {
		expect(PROVISION_STEPS).toContain("Downloading the client")
		expect(PROVISION_STEPS).toContain("Verifying the download")
		expect(PROVISION_STEPS).toContain("Installing the client")
	})

	it("keeps verification between the download and the install, which is the whole point", () => {
		const download = PROVISION_STEPS.indexOf("Downloading the client")
		const verify = PROVISION_STEPS.indexOf("Verifying the download")
		const install = PROVISION_STEPS.indexOf("Installing the client")
		expect(download).toBeLessThan(verify)
		expect(verify).toBeLessThan(install)
	})
})
