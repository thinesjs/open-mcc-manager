import { describe, expect, it } from "vitest"
import { labelFor } from "./os-icon"

describe("labelling a host's distribution", () => {
	it("prefers the name the host reported over its identifier", () => {
		expect(labelFor("ubuntu", "Ubuntu 24.04.1 LTS")).toBe("Ubuntu 24.04.1 LTS")
	})

	it("falls back to the identifier when the host reported no name", () => {
		expect(labelFor("almalinux", null)).toBe("almalinux")
	})

	it("trims the stray whitespace os-release values sometimes carry", () => {
		expect(labelFor(" debian ", null)).toBe("debian")
	})

	it("keeps a reported name even when the host reported no identifier", () => {
		expect(labelFor(null, "Ubuntu")).toBe("Ubuntu")
	})

	it("shows nothing at all when the host has never told us what it runs", () => {
		expect(labelFor(null, null)).toBeUndefined()
		expect(labelFor("  ", "  ")).toBeUndefined()
	})
})
