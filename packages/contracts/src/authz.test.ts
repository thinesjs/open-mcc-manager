import { describe, expect, it } from "vitest"
import { CAPABILITIES, can } from "./authz"

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
