import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const SCRIPT = join(ROOT, "scripts", "install.sh")
const source = readFileSync(SCRIPT, "utf8")

const lineOf = (needle: string): number =>
	source.split("\n").findIndex((line) => line.includes(needle))

describe("the installer as a shell program", () => {
	it("parses, so a change to it is not discovered by an operator running it", () => {
		const result = spawnSync("sh", ["-n", SCRIPT], { encoding: "utf8" })

		expect(result.stderr).toBe("")
		expect(result.status).toBe(0)
	})
})

describe("how the installer prepares this machine as its own host", () => {
	it("has the control plane mint the key, so no plaintext private half is ever written", () => {
		expect(source).toContain("server.mjs --seal-self-host-key")
	})

	it("passes only the public half to the script that installs it", () => {
		expect(source).toContain("sh scripts/self-host.sh --public-key -")
	})

	it("keeps the sealbox keys off the docker argv, where any local user could read them", () => {
		expect(source).toContain("-e SEALBOX_KEYS ")
		expect(source).not.toMatch(/-e SEALBOX_KEYS=/)
	})

	it("appends the materials only on the success of the script that writes them", () => {
		const appendAt = lineOf("cat .env.self-host >> .env")
		const conditionAt = lineOf("sh scripts/self-host.sh --public-key -")

		expect(conditionAt).toBeGreaterThan(-1)
		expect(appendAt).toBeGreaterThan(conditionAt)
	})

	it("restarts the stack afterwards, or the server would never read what was appended", () => {
		const appendAt = lineOf("cat .env.self-host >> .env")
		const restarts = source
			.split("\n")
			.map((line, at) => ({ line, at }))
			.filter((each) => each.line.includes("docker compose --env-file .env"))

		expect(restarts.some((each) => each.at > appendAt)).toBe(true)
	})

	it("does that after the stack is up, so the probe runs on the network the server is on", () => {
		const firstUp = lineOf("docker compose --env-file .env -f docker/compose.yml up -d")
		const mintAt = lineOf("server.mjs --seal-self-host-key")

		expect(firstUp).toBeGreaterThan(-1)
		expect(mintAt).toBeGreaterThan(firstUp)
	})

	it("still finishes when this machine cannot be offered, because that is not the install", () => {
		expect(source).toContain('SELF_HOST_OFFERED="no"')
		expect(source).toContain('|| SELF_HOST_KEY=""')
	})
})
