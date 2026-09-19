import { describe, expect, it } from "vitest"
import { keyTypeOf } from "./ssh-key-type"

describe("naming the algorithm a key uses", () => {
	it("reads the algorithm from the key itself", () => {
		expect(keyTypeOf("ssh-ed25519 AAAAC3Nz... open-mcc:fleet")).toBe("ED25519")
		expect(keyTypeOf("ssh-rsa AAAAB3Nz... comment")).toBe("RSA")
		expect(keyTypeOf("ecdsa-sha2-nistp256 AAAA... c")).toBe("ECDSA")
	})

	it("copes with leading whitespace rather than mislabelling the key", () => {
		expect(keyTypeOf("  ssh-ed25519 AAAA")).toBe("ED25519")
	})

	it("says so plainly for an algorithm it does not know", () => {
		expect(keyTypeOf("ssh-future AAAA")).toBe("Unknown")
		expect(keyTypeOf("")).toBe("Unknown")
	})
})
