import { describe, expect, it } from "vitest"
import { HOST_CONTROLS, mayUseHostControl } from "./host-actions"

describe("which host page actions a role is offered", () => {
	it("offers an owner every action", () => {
		for (const control of HOST_CONTROLS) {
			expect(mayUseHostControl("owner", control)).toBe(true)
		}
	})

	it.each(["operator", "viewer"] as const)(
		"offers a %s none of them, since the server would refuse each",
		(role) => {
			for (const control of HOST_CONTROLS) {
				expect(mayUseHostControl(role, control)).toBe(false)
			}
		},
	)

	it("offers nothing while the role is still unknown", () => {
		for (const control of HOST_CONTROLS) {
			expect(mayUseHostControl(undefined, control)).toBe(false)
		}
	})

	it("covers every action the host page renders", () => {
		expect([...HOST_CONTROLS]).toEqual(["createInstance", "setUp", "remove"])
	})
})
