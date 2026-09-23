import { DOWNLOAD_STEP_LABEL, PROVISION_STEP_LABELS, STORAGE_STEP_LABEL } from "@open-mcc/contracts"
import { describe, expect, it } from "vitest"
import { STORAGE_STEP_WORDS } from "./podman-facts"
import {
	DOWNLOAD_RAN_OUT_OF_TIME,
	PROVISIONING_STOPPED_EARLY,
	provisioningFailureFor,
} from "./provision-failure"

const storageOutcomes = [...STORAGE_STEP_WORDS, null].map((word) => ({
	word,
	sentence: provisioningFailureFor(STORAGE_STEP_LABEL, word),
}))

describe("what an operator is told when provisioning stops", () => {
	it("gives every step a sentence, and a run that reached none its own", () => {
		for (const step of PROVISION_STEP_LABELS) {
			expect(provisioningFailureFor(step, null).length).toBeGreaterThan(0)
		}
		expect(provisioningFailureFor(undefined, null)).toBe(PROVISIONING_STOPPED_EARLY)
	})

	it("says the same thing for every other step, whatever the storage step printed", () => {
		for (const step of PROVISION_STEP_LABELS.filter((label) => label !== STORAGE_STEP_LABEL)) {
			expect(provisioningFailureFor(step, "used")).toBe(provisioningFailureFor(step, null))
		}
	})

	it("tells a download that ran out of time from one that failed some other way", () => {
		const ranOut = provisioningFailureFor(DOWNLOAD_STEP_LABEL, null, true)

		expect(ranOut).toBe(DOWNLOAD_RAN_OUT_OF_TIME)
		expect(ranOut).not.toBe(provisioningFailureFor(DOWNLOAD_STEP_LABEL, null, false))
	})

	it("says a download ran out of time for no step but the download", () => {
		for (const step of PROVISION_STEP_LABELS.filter((label) => label !== DOWNLOAD_STEP_LABEL)) {
			expect(provisioningFailureFor(step, null, true)).not.toBe(DOWNLOAD_RAN_OUT_OF_TIME)
		}
	})

	it("tells the storage step's outcomes apart", () => {
		expect(new Set(storageOutcomes.map((each) => each.sentence)).size).toBe(storageOutcomes.length)
	})

	it("blames an account that has run Podman only where the host said it had", () => {
		for (const { word, sentence } of storageOutcomes) {
			if (word === "used") expect(sentence).toContain("never run Podman")
			else expect(sentence).not.toContain("never run Podman")
		}
	})

	it("names every setting that could be sending storage elsewhere, because it cannot tell which", () => {
		const sentence = provisioningFailureFor(STORAGE_STEP_LABEL, "refused")

		for (const setting of [
			"XDG_CONFIG_HOME",
			"XDG_DATA_HOME",
			"CONTAINERS_STORAGE_CONF",
			"rootless_storage_path",
		]) {
			expect(sentence).toContain(setting)
		}
	})

	it("sends the operator to Podman's own answer when the step printed no word at all", () => {
		const sentence = provisioningFailureFor(STORAGE_STEP_LABEL, null)

		expect(sentence).toContain("podman info")
		expect(sentence).not.toContain("fresh account")
	})
})
