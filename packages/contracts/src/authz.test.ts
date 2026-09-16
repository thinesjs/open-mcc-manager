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

describe("audit.read", () => {
	it("is granted to owner only, because the trail carries member and SSH-key activity", () => {
		expect(can("owner", "audit.read")).toBe(true)
		expect(can("operator", "audit.read")).toBe(false)
		expect(can("viewer", "audit.read")).toBe(false)
	})
})

describe("instance.authenticate", () => {
	it("is granted to owner only, because it binds a real account to a real host", () => {
		expect(can("owner", "instance.authenticate")).toBe(true)
		expect(can("operator", "instance.authenticate")).toBe(false)
		expect(can("viewer", "instance.authenticate")).toBe(false)
	})

	it("is distinct from instance.create, which is only bookkeeping", () => {
		expect(can("operator", "instance.start")).toBe(true)
		expect(can("operator", "instance.authenticate")).toBe(false)
	})
})
