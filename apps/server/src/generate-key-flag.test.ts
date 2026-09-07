import { describe, expect, it } from "vitest"
import { GENERATE_KEY_FLAG, generateSealboxKeyFromArgv } from "./sealbox-key-argv"

describe("sealbox key generation from the command line", () => {
	it("emits a key entry the SEALBOX_KEYS format accepts", async () => {
		const entry = await generateSealboxKeyFromArgv(["node", "server.mjs", GENERATE_KEY_FLAG, "k1"])
		const parts = entry.split(":")

		expect(parts).toHaveLength(3)
		expect(parts[0]).toBe("k1")
		expect(parts[1]?.length).toBeGreaterThan(20)
		expect(parts[2]?.length).toBeGreaterThan(20)
	})

	it("defaults the key id when none is given", async () => {
		const entry = await generateSealboxKeyFromArgv(["node", "server.mjs", GENERATE_KEY_FLAG])
		expect(entry.startsWith("k1:")).toBe(true)
	})

	it("never emits the key that ships in the development overlay", async () => {
		const entry = await generateSealboxKeyFromArgv(["node", "server.mjs", GENERATE_KEY_FLAG, "k1"])
		expect(entry).not.toContain("dev-insecure-publicly-known")
		expect(entry).not.toContain("Am5fPqmntZmYRD3qh57huQfRy")
	})

	it("generates a different key every time, so two installs never share one", async () => {
		const first = await generateSealboxKeyFromArgv(["node", "server.mjs", GENERATE_KEY_FLAG, "k1"])
		const second = await generateSealboxKeyFromArgv(["node", "server.mjs", GENERATE_KEY_FLAG, "k1"])
		expect(first).not.toBe(second)
	})

	it("refuses a key id that could break the SEALBOX_KEYS field separator", async () => {
		for (const keyId of ["a:b", "has space", "", "x".repeat(65)]) {
			await expect(
				generateSealboxKeyFromArgv(["node", "server.mjs", GENERATE_KEY_FLAG, keyId]),
			).rejects.toThrow()
		}
	})
})
