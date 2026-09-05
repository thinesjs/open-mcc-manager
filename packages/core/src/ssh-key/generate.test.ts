import sshpk from "sshpk"
import { describe, expect, it } from "vitest"
import { generateSshKeyPair } from "./generate"

describe("generateSshKeyPair", () => {
	it("produces an OpenSSH-formatted ed25519 public key", () => {
		const { publicKey } = generateSshKeyPair("fleet")
		expect(publicKey.startsWith("ssh-ed25519 ")).toBe(true)
	})

	it("produces a private key that parses as an OpenSSH ed25519 key", () => {
		const { privateKey } = generateSshKeyPair("fleet")
		const parsed = sshpk.parsePrivateKey(privateKey, "auto")
		expect(parsed.type).toBe("ed25519")
	})

	it("produces a public and private key that are a matching pair", () => {
		const { publicKey, privateKey } = generateSshKeyPair("fleet")
		const parsedPublic = sshpk.parseKey(publicKey, "ssh")
		const parsedPrivate = sshpk.parsePrivateKey(privateKey, "auto")
		expect(parsedPrivate.toPublic().fingerprint("sha256").toString()).toBe(
			parsedPublic.fingerprint("sha256").toString(),
		)
	})

	it("produces a different key pair on each call", () => {
		const first = generateSshKeyPair("fleet")
		const second = generateSshKeyPair("fleet")
		expect(first.publicKey).not.toBe(second.publicKey)
	})
})

describe("naming a generated key so it is identifiable in authorized_keys", () => {
	it("carries the key's own name, not a placeholder", () => {
		const pair = generateSshKeyPair("fleet-production")

		expect(pair.publicKey.trim().endsWith("open-mcc:fleet-production")).toBe(true)
		expect(pair.publicKey).not.toContain("(unnamed)")
	})

	it("marks the key as this control plane's, so an operator knows what put it there", () => {
		expect(generateSshKeyPair("anything").publicKey).toContain("open-mcc:")
	})

	it("keeps the comment on one line, since authorized_keys is line-oriented", () => {
		const pair = generateSshKeyPair("two\nlines and spaces")

		expect(pair.publicKey.trim().split("\n")).toHaveLength(1)
		expect(pair.publicKey).not.toContain(" lines and spaces")
	})

	it("falls back to a bare marker rather than an empty comment", () => {
		expect(generateSshKeyPair("!!!").publicKey.trim().endsWith("open-mcc")).toBe(true)
	})

	it("caps a very long name rather than writing an unbounded comment", () => {
		const pair = generateSshKeyPair("x".repeat(200))
		const comment = pair.publicKey.trim().split(" ")[2] ?? ""

		expect(comment.length).toBeLessThanOrEqual("open-mcc:".length + 48)
	})
})
