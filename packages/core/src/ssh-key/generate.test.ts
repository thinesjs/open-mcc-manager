import sshpk from "sshpk"
import { describe, expect, it } from "vitest"
import { generateSshKeyPair } from "./generate"

describe("generateSshKeyPair", () => {
	it("produces an OpenSSH-formatted ed25519 public key", () => {
		const { publicKey } = generateSshKeyPair()
		expect(publicKey.startsWith("ssh-ed25519 ")).toBe(true)
	})

	it("produces a private key that parses as an OpenSSH ed25519 key", () => {
		const { privateKey } = generateSshKeyPair()
		const parsed = sshpk.parsePrivateKey(privateKey, "auto")
		expect(parsed.type).toBe("ed25519")
	})

	it("produces a public and private key that are a matching pair", () => {
		const { publicKey, privateKey } = generateSshKeyPair()
		const parsedPublic = sshpk.parseKey(publicKey, "ssh")
		const parsedPrivate = sshpk.parsePrivateKey(privateKey, "auto")
		expect(parsedPrivate.toPublic().fingerprint("sha256").toString()).toBe(
			parsedPublic.fingerprint("sha256").toString(),
		)
	})

	it("produces a different key pair on each call", () => {
		const first = generateSshKeyPair()
		const second = generateSshKeyPair()
		expect(first.publicKey).not.toBe(second.publicKey)
	})
})
