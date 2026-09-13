import { createSecretStore } from "@open-mcc/core"
import { describe, expect, it } from "vitest"
import { generateSealboxKey } from "./sealbox-key-argv"
import { SEAL_SELF_HOST_KEY_FLAG, sealSelfHostKeyFromArgv } from "./self-host-key-argv"

const sealboxKeys = async (): Promise<string> => await generateSealboxKey("k1")

const fields = (output: string): Map<string, string> => {
	const found = new Map<string, string>()
	for (const line of output.split("\n")) {
		const separator = line.indexOf("=")
		if (separator === -1) continue
		found.set(line.slice(0, separator), line.slice(separator + 1))
	}
	return found
}

const sealed = async (keys: string, name?: string): Promise<Map<string, string>> =>
	fields(
		await sealSelfHostKeyFromArgv(
			["node", "server.mjs", SEAL_SELF_HOST_KEY_FLAG, ...(name === undefined ? [] : [name])],
			{ SEALBOX_KEYS: keys },
		),
	)

describe("the self-host key this flag mints", () => {
	it("emits exactly the three fields an install appends, one per line", async () => {
		const output = await sealSelfHostKeyFromArgv(["node", "server.mjs", SEAL_SELF_HOST_KEY_FLAG], {
			SEALBOX_KEYS: await sealboxKeys(),
		})

		expect(output.split("\n")).toHaveLength(3)
		expect([...fields(output).keys()]).toEqual([
			"SELF_HOST_PUBLIC_KEY",
			"SELF_HOST_PRIVATE_KEY_SEALED",
			"SELF_HOST_PRIVATE_KEY_ID",
		])
	})

	it("never prints the private half, which is the whole point of sealing it", async () => {
		const keys = await sealboxKeys()
		const output = await sealSelfHostKeyFromArgv(["node", "server.mjs", SEAL_SELF_HOST_KEY_FLAG], {
			SEALBOX_KEYS: keys,
		})

		expect(output).not.toContain("PRIVATE KEY")
		expect(output).not.toContain("BEGIN")
	})

	it("seals the private half so the store this deployment holds can open it again", async () => {
		const keys = await sealboxKeys()
		const emitted = await sealed(keys)
		const store = await createSecretStore(keys)
		const ciphertext = emitted.get("SELF_HOST_PRIVATE_KEY_SEALED") ?? ""
		const keyId = emitted.get("SELF_HOST_PRIVATE_KEY_ID") ?? ""

		expect(store.open(ciphertext, keyId)).toContain("OPENSSH PRIVATE KEY")
	})

	it("names the key id its own store knows, or nothing could ever open it", async () => {
		const keys = await sealboxKeys()
		const emitted = await sealed(keys)

		expect(emitted.get("SELF_HOST_PRIVATE_KEY_ID")).toBe("k1")
	})

	it("emits a public key a host's authorized_keys accepts on one line", async () => {
		const emitted = await sealed(await sealboxKeys())

		expect(emitted.get("SELF_HOST_PUBLIC_KEY")).toMatch(/^ssh-ed25519 [A-Za-z0-9+/=]+ open-mcc:/)
	})

	it("carries the name it was given into the key comment", async () => {
		const emitted = await sealed(await sealboxKeys(), "kitchen pi")

		expect(emitted.get("SELF_HOST_PUBLIC_KEY")).toContain("open-mcc:kitchen-pi")
	})

	it("mints a different key every time, so two installs never share one", async () => {
		const keys = await sealboxKeys()
		const first = await sealed(keys)
		const second = await sealed(keys)

		expect(first.get("SELF_HOST_PUBLIC_KEY")).not.toBe(second.get("SELF_HOST_PUBLIC_KEY"))
	})

	it("refuses to mint anything when there is no store to seal it with", async () => {
		await expect(
			sealSelfHostKeyFromArgv(["node", "server.mjs", SEAL_SELF_HOST_KEY_FLAG], {}),
		).rejects.toThrow("SEALBOX_KEYS")
		await expect(
			sealSelfHostKeyFromArgv(["node", "server.mjs", SEAL_SELF_HOST_KEY_FLAG], {
				SEALBOX_KEYS: "   ",
			}),
		).rejects.toThrow("SEALBOX_KEYS")
	})

	it("reads no name out of a following flag, which would land in the key comment", async () => {
		const emitted = await sealed(await sealboxKeys(), "--port")

		expect(emitted.get("SELF_HOST_PUBLIC_KEY")).toContain("open-mcc:this-machine")
	})
})
