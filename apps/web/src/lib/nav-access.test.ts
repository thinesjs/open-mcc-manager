import { describe, expect, it } from "vitest"
import { navItemVisible } from "./nav-access"

describe("which sidebar entries a role sees", () => {
	it("keeps Alerts out of the sidebar for someone who cannot see alerts", () => {
		expect(navItemVisible("viewer", "/alerts")).toBe(false)
	})

	it("shows Alerts to an operator and an owner", () => {
		expect(navItemVisible("operator", "/alerts")).toBe(true)
		expect(navItemVisible("owner", "/alerts")).toBe(true)
	})

	it("hides nothing while the role is still unknown, except what is gated", () => {
		expect(navItemVisible(undefined, "/alerts")).toBe(false)
		expect(navItemVisible(undefined, "/hosts")).toBe(true)
	})

	it("leaves every ungated entry alone", () => {
		for (const to of ["/overview", "/instances", "/hosts", "/status", "/ssh-keys"]) {
			expect(navItemVisible("viewer", to)).toBe(true)
		}
	})
})
