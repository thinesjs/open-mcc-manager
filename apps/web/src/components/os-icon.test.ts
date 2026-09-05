import { describe, expect, it } from "vitest"
import { markFor } from "./os-icon"

describe("picking a mark for a host's distribution", () => {
	it("recognises the identifiers os-release actually reports", () => {
		expect(markFor("ubuntu").title).toBe("Ubuntu")
		expect(markFor("debian").title).toBe("Debian")
		expect(markFor("alpine").title).toBe("Alpine Linux")
		expect(markFor("rocky").title).toBe("Rocky Linux")
	})

	it("treats the openSUSE variants as one distribution", () => {
		expect(markFor("opensuse-leap").title).toBe("openSUSE")
		expect(markFor("opensuse-tumbleweed").title).toBe("openSUSE")
	})

	it("ignores casing and stray whitespace, which os-release values sometimes carry", () => {
		expect(markFor(" Ubuntu ").title).toBe("Ubuntu")
	})

	it("falls back to a generic mark rather than showing nothing for an unknown host", () => {
		expect(markFor("someos").title).toBe("Linux")
		expect(markFor(null).title).toBe("Linux")
	})
})
