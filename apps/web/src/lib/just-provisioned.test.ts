import { describe, expect, it } from "vitest"
import { sawProvisioningFinish, stillShowingCompletion } from "./just-provisioned"

describe("noticing that provisioning finished while the page was open", () => {
	it("recognises the moment it becomes ready", () => {
		expect(sawProvisioningFinish("provisioning", "ready")).toBe(true)
	})

	it("does not claim completion for a host that was already ready when opened", () => {
		expect(sawProvisioningFinish("ready", "ready")).toBe(false)
		expect(sawProvisioningFinish(undefined, "ready")).toBe(false)
	})

	it("does not claim completion when provisioning failed", () => {
		expect(sawProvisioningFinish("provisioning", "error")).toBe(false)
	})

	it("keeps showing the completion until the host leaves the ready state", () => {
		expect(stillShowingCompletion("ready", true)).toBe(true)
		expect(stillShowingCompletion("provisioning", true)).toBe(false)
		expect(stillShowingCompletion("ready", false)).toBe(false)
	})
})
