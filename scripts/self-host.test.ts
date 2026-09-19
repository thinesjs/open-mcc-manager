import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it } from "vitest"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const SCRIPT = join(ROOT, "scripts", "self-host.sh")

const temporaries: string[] = []

const scratch = (): string => {
	const made = mkdtempSync(join(tmpdir(), "self-host-"))
	temporaries.push(made)
	return made
}

const quietPort = async (): Promise<number> =>
	await new Promise((resolve, reject) => {
		const server = createServer()
		server.on("error", reject)
		server.listen(0, "127.0.0.1", () => {
			const address = server.address()
			if (address === null || typeof address === "string") {
				reject(new Error("no port"))
				return
			}
			const { port } = address
			server.close(() => resolve(port))
		})
	})

const run = (args: string[], home?: string, materials?: string) =>
	spawnSync("sh", [SCRIPT, ...args], {
		cwd: ROOT,
		encoding: "utf8",
		env: {
			...process.env,
			...(home === undefined ? {} : { HOME: home }),
			...(materials === undefined ? {} : { OPEN_MCC_SELF_HOST_ENV: materials }),
		},
	})

afterEach(() => {
	for (const made of temporaries.splice(0)) rmSync(made, { force: true, recursive: true })
})

describe("what the script accepts", () => {
	it("explains itself and stops", () => {
		const result = run(["--help"])
		expect(result.status).toBe(0)
		expect(result.stdout).toContain("--public-key")
	})

	it("refuses a port that is not a number", () => {
		const result = run(["--port", "twenty-two"])
		expect(result.status).not.toBe(0)
		expect(result.stderr).toContain("port must be a number")
	})

	it("refuses an argument it does not know", () => {
		const result = run(["--delete-everything"])
		expect(result.status).not.toBe(0)
		expect(result.stderr).toContain("unknown argument")
	})

	it("refuses --public-key with nothing after it", () => {
		const result = run(["--public-key"])
		expect(result.status).not.toBe(0)
		expect(result.stderr).toContain("--public-key needs a file")
	})
})

describe("when nothing is listening for ssh", () => {
	it("stops before it has changed anything", async () => {
		const home = scratch()
		const materials = join(scratch(), "materials.env")
		const port = await quietPort()

		const result = run(["--port", String(port)], home, materials)

		expect(result.status).not.toBe(0)
		expect(readdirSync(home)).toEqual([])
		expect(existsSync(materials)).toBe(false)
	})
})

describe("the restrictions the entry carries", () => {
	const script = readFileSync(SCRIPT, "utf8")

	it("keeps the key away from everything sshd can turn off", () => {
		expect(script).toContain("restrict,port-forwarding")
	})

	it("lets the key reach only this machine's own loopback", () => {
		expect(script).toContain('permitopen=\\"127.0.0.1:*\\"')
	})

	it("pins the key to a forced command", () => {
		expect(script).toContain('command=\\"')
	})

	it("gives that command no interactive shell to fall back to", () => {
		expect(script).toContain("it has no interactive shell")
	})
})

describe("the address it proves and the address the control plane later uses", () => {
	const script = readFileSync(SCRIPT, "utf8")
	const compose = readFileSync(join(ROOT, "docker", "compose.yml"), "utf8")

	const aliasOf = (source: string): string | undefined =>
		source.match(/host\.docker\.internal:host-gateway/)?.[0]

	it("probes under the same alias the server container is given, or it proves the wrong name", () => {
		expect(aliasOf(script)).toBeDefined()
		expect(aliasOf(script)).toBe(aliasOf(compose))
	})

	it("hands that alias to the probe container, which inherits nothing from the compose services", () => {
		expect(script).toContain('--add-host "host.docker.internal:host-gateway"')
	})
})

describe("what it tells an operator about the key it minted", () => {
	const script = readFileSync(SCRIPT, "utf8")

	it("no longer claims the control plane cannot take a key it already holds", () => {
		expect(script).not.toContain("has no way to import")
	})

	it("names the flag that seals one instead, so no plaintext key is the answer", () => {
		expect(script).toContain("--seal-self-host-key")
	})
})
