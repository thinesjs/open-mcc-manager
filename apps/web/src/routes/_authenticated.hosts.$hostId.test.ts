import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

const source = readFileSync(join(__dirname, "_authenticated.hosts.$hostId.tsx"), "utf8")

const buttonBlockAfter = (gate: string): string => {
	const start = source.indexOf(gate)
	return start === -1 ? "" : source.slice(start, start + 700)
}

describe("host page actions a role cannot use", () => {
	it("renders New instance only for a role that may create one", () => {
		expect(buttonBlockAfter('mayUseHostControl(role, "createInstance")')).toContain("New instance")
	})

	it("renders Set up and Repair setup only for a role that may set up a host", () => {
		const block = buttonBlockAfter('mayUseHostControl(role, "setUp")')
		expect(block).toContain("setConfirmingProvision(true)")
		expect(block).toContain('"Repair setup"')
	})

	it("renders Remove only for a role that may remove a host", () => {
		expect(buttonBlockAfter('mayUseHostControl(role, "remove")')).toContain(
			"setConfirmingRemove(true)",
		)
	})

	it("reads the role from the signed-in member", () => {
		expect(source).toContain("const role = me.data?.role")
	})
})

describe("what the host page says about a host", () => {
	it("shows no privilege row and no isolation label, since every host runs bots one way", () => {
		expect(source).not.toContain("Privilege")
		expect(source).not.toContain("confinementLabel")
		expect(source).not.toContain("Bot isolation")
		expect(source).not.toContain("host.mode")
		expect(source).not.toContain("host.sandboxed")
	})
})
