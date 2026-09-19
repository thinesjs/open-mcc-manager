import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

const source = readFileSync(join(__dirname, "_authenticated.hosts.$hostId.tsx"), "utf8")
const controls = readFileSync(join(__dirname, "..", "components", "host-controls.tsx"), "utf8")

const buttonBlockAfter = (gate: string): string => {
	const start = controls.indexOf(gate)
	return start === -1 ? "" : controls.slice(start, start + 700)
}

describe("host page actions a role cannot use", () => {
	it("renders New instance only for a role that may create one", () => {
		expect(buttonBlockAfter('mayUseHostControl(role, "createInstance")')).toContain("New instance")
	})

	it("renders Set up and Repair setup only for a role that may set up a host", () => {
		const block = buttonBlockAfter('mayUseHostControl(role, "setUp")')
		expect(block).toContain("onClick={onSetUp}")
		expect(block).toContain('"Repair setup"')
		expect(source).toContain("onSetUp={() => setConfirmingProvision(true)}")
	})

	it("renders Remove only for a role that may remove a host", () => {
		expect(buttonBlockAfter('mayUseHostControl(role, "remove")')).toContain("onClick={onRemove}")
		expect(source).toContain("onRemove={() => setConfirmingRemove(true)}")
	})

	it("reads the role from the signed-in member", () => {
		expect(source).toContain("const role = me.data?.role")
	})
})

describe("what the host page says about a host", () => {
	it("shows no privilege row and no isolation label, since every host runs bots one way", () => {
		for (const text of [source, controls]) {
			expect(text).not.toContain("Privilege")
			expect(text).not.toContain("confinementLabel")
			expect(text).not.toContain("Bot isolation")
			expect(text).not.toContain("host.mode")
			expect(text).not.toContain("host.sandboxed")
		}
	})
})
