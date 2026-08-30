import { describe, expect, it } from "vitest"
import { CAPABILITIES, can, isRole, roleSchema } from "./authz"

describe("can", () => {
	it("lets every role read", () => {
		expect(can("viewer", "instance.read")).toBe(true)
		expect(can("operator", "instance.read")).toBe(true)
		expect(can("owner", "instance.read")).toBe(true)
	})

	it("denies viewers any mutation", () => {
		expect(can("viewer", "instance.start")).toBe(false)
		expect(can("viewer", "console.write")).toBe(false)
		expect(can("viewer", "config.edit")).toBe(false)
	})

	it("denies operators owner-only capabilities", () => {
		expect(can("operator", "instance.create")).toBe(false)
		expect(can("operator", "host.enroll")).toBe(false)
		expect(can("operator", "sshKey.manage")).toBe(false)
		expect(can("operator", "member.manage")).toBe(false)
	})

	it("grants owners everything", () => {
		for (const capability of CAPABILITIES) {
			expect(can("owner", capability)).toBe(true)
		}
	})
})

describe("isRole", () => {
	it("accepts every known role", () => {
		expect(isRole("owner")).toBe(true)
		expect(isRole("operator")).toBe(true)
		expect(isRole("viewer")).toBe(true)
	})

	it("rejects an arbitrary string", () => {
		expect(isRole("admin")).toBe(false)
		expect(isRole("")).toBe(false)
	})
})

describe("roleSchema", () => {
	it("parses a known role", () => {
		expect(roleSchema.parse("owner")).toBe("owner")
	})

	it("throws for an unknown role", () => {
		expect(() => roleSchema.parse("admin")).toThrow()
	})
})
