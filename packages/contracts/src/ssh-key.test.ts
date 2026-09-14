import { describe, expect, it } from "vitest"
import { sshKeyPublic } from "./ssh-key"

const key = {
	id: "key-1",
	name: "deploy",
	publicKey: "ssh-ed25519 AAAApublic",
}

describe("the ssh key the wire actually sends", () => {
	it("requires the ISO string a JSON response carries, not a Date object", () => {
		expect(sshKeyPublic.safeParse({ ...key, createdAt: new Date() }).success).toBe(false)
		expect(sshKeyPublic.safeParse({ ...key, createdAt: "2026-08-30T00:00:00.000Z" }).success).toBe(
			true,
		)
	})
})
