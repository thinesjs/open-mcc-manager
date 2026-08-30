import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

const source = readFileSync(join(__dirname, "_authenticated.ssh-keys.tsx"), "utf8")

describe("ssh key deletion copy and error surface", () => {
	it("warns that a key an enrolled host uses cannot be deleted", () => {
		expect(source).toContain("cannot be deleted")
		expect(source).toContain("remove those hosts first")
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
