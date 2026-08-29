import { beforeAll, describe, expect, it } from "vitest"
import { createSecretStore, generateKeyPair } from "./sealed-box"

let specA = ""
let specAB = ""

beforeAll(async () => {
	const a = await generateKeyPair("k1")
	const b = await generateKeyPair("k2")
	specA = a
	specAB = `${b},${a}`
})

describe("createSecretStore", () => {
	it("round-trips a value under the active key", async () => {
		const store = await createSecretStore(specA)
		const sealed = store.seal("hunter2")
		expect(sealed.keyId).toBe("k1")
		expect(store.open(sealed.ciphertext, sealed.keyId)).toBe("hunter2")
	})

	it("seals under the first key but opens under any", async () => {
		const older = await createSecretStore(specA)
		const sealedOld = older.seal("legacy")
		const rotated = await createSecretStore(specAB)
		expect(rotated.activeKeyId).toBe("k2")
		expect(rotated.open(sealedOld.ciphertext, "k1")).toBe("legacy")
		expect(rotated.seal("fresh").keyId).toBe("k2")
	})

	it("rejects an unknown key id", async () => {
		const store = await createSecretStore(specA)
		expect(() => store.open("zzz", "missing")).toThrow(/no key/i)
	})

	it("rejects an empty key set", async () => {
		await expect(createSecretStore("")).rejects.toThrow(/at least one key/i)
	})
})

describe("createSecretStore duplicate keyId handling", () => {
	it("rejects a duplicate keyId with different key material and names it", async () => {
		const first = await generateKeyPair("dup")
		const second = await generateKeyPair("dup")
		await expect(createSecretStore(`${first},${second}`)).rejects.toThrow(/dup/)
	})

	it("rejects a duplicate keyId even with identical key material", async () => {
		const entry = await generateKeyPair("dup")
		await expect(createSecretStore(`${entry},${entry}`)).rejects.toThrow(/dup/i)
	})

	it("constructs normally and round-trips when keyIds are distinct", async () => {
		const store = await createSecretStore(specAB)
		const sealed = store.seal("distinct")
		expect(store.open(sealed.ciphertext, sealed.keyId)).toBe("distinct")
	})

	it("keeps key material out of the duplicate keyId error message", async () => {
		const entry = await generateKeyPair("dup")
		const parts = entry.split(":")
		const pub = parts[1]
		const priv = parts[2]
		if (!pub || !priv) throw new Error("test setup: malformed generated key pair")

		try {
			await createSecretStore(`${entry},${entry}`)
			throw new Error("expected createSecretStore to reject a duplicate keyId")
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			expect(message).not.toContain(pub)
			expect(message).not.toContain(priv)
		}
	})
})
