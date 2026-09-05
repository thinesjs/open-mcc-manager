import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { createServer, type Server } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createSshTransport } from "./connection"

const FINGERPRINT = `SHA256:${"A".repeat(43)}`

let port = 0
let server: Server
let privateKey = ""
let keyDir = ""

beforeAll(async () => {
	server = createServer((socket) => socket.destroy())
	await new Promise<void>((resolve) => {
		server.listen(0, "127.0.0.1", () => resolve())
	})
	const address = server.address()
	port = typeof address === "object" && address ? address.port : 0

	keyDir = mkdtempSync(join(tmpdir(), "leak-key-"))
	const keyPath = join(keyDir, "id_ed25519")
	execFileSync("ssh-keygen", ["-t", "ed25519", "-N", "", "-f", keyPath, "-q"])
	privateKey = readFileSync(keyPath, "utf8")
})

afterAll(async () => {
	await new Promise<void>((resolve) => {
		server.close(() => resolve())
	})
	rmSync(keyDir, { recursive: true, force: true })
})

const connectWith = async (key: string) => {
	const transport = createSshTransport()
	const error = await transport
		.connect({
			hostname: "127.0.0.1",
			port,
			username: "root",
			privateKey: key,
			expectedFingerprint: FINGERPRINT,
			timeoutMs: 2_000,
		})
		.then(() => undefined)
		.catch((cause: Error) => cause)
	return { transport, error }
}

describe("a connection that never succeeds", () => {
	it("settles as failed when the peer drops it", async () => {
		const { transport, error } = await connectWith(privateKey)

		expect(error).toBeInstanceOf(Error)
		expect(transport.state()).toBe("failed")
	})

	it("settles as failed when the key cannot even be parsed, rather than staying connecting", async () => {
		const { transport, error } = await connectWith("not-a-usable-private-key")

		expect(error).toBeInstanceOf(Error)
		expect(transport.state()).toBe("failed")
	})

	it("can be closed after failing, however it failed", async () => {
		for (const key of [privateKey, "not-a-usable-private-key"]) {
			const { transport } = await connectWith(key)
			await expect(transport.close()).resolves.toBeUndefined()
		}
	})
})
