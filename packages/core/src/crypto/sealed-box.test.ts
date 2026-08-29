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
