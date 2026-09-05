import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

const source = readFileSync(join(__dirname, "_authenticated.ssh-keys.tsx"), "utf8")

describe("ssh key deletion copy and error surface", () => {
	it("warns that hosts referencing the key must be removed first", () => {
		expect(source).toContain("must be removed first")
		expect(source).toContain("unreachable")
	})

	it("asks through a dialog rather than a browser prompt", () => {
		expect(source).toContain("ConfirmDialog")
		expect(source).not.toContain("window.confirm")
	})

	it("never promises that hosts enrolled with a deleted key keep working", () => {
		expect(source).not.toContain("Hosts enrolled with it will keep working")
		expect(source).not.toContain("keep working")
	})

	it("renders a failed deletion through the shared error-code table", () => {
		expect(source).toContain("deleteMutation.isError")
		expect(source).toContain("getErrorMessage(deleteMutation.error)")
	})

	it("never renders a raw server message on any path", () => {
		expect(source).not.toContain(".error.message")
		expect(source).not.toContain("error.cause")
	})
})

describe("ssh key screen variant restraint", () => {
	it("keeps the delete control on the outline destructive treatment", () => {
		expect(source).toContain('variant="destructive-outline"')
		expect(source).not.toContain('variant="destructive"')
	})

	it("keeps the private-key notice on the restrained info alert", () => {
		expect(source).toContain('<Alert variant="info"')
		expect(source).not.toContain('variant="warning"')
	})
})
