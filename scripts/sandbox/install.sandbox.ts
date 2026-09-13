import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"
import {
	docker,
	exec,
	type Ran,
	REPOSITORY,
	ROOT,
	read,
	remove,
	run,
	shell,
	startDocker,
	succeeded,
} from "./sandbox"

const INSTALL_TIMEOUT_MS = 1_800_000

const KNOWN_DEV_KEY_ID = "dev-insecure-publicly-known"
const KNOWN_DEV_SECRET = "dev-only-secret-change-me-before-any-real-deploy"
const DEVELOPMENT_ONLY = ["DEV_DB_PORT", "TEST_DB_PORT", "TEST_DATABASE_URL"]

let machine = ""

beforeAll(async () => {
	machine = await startDocker(inject("sandboxRun"))
	const listed = succeeded(
		await run("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
			cwd: REPOSITORY,
		}),
		"listing the checkout",
	)
	const scratch = mkdtempSync(join(tmpdir(), "open-mcc-checkout-"))
	try {
		const archive = join(scratch, "checkout.tar")
		succeeded(
			await run(
				"env",
				["COPYFILE_DISABLE=1", "tar", "-C", REPOSITORY, "--null", "-T", "-", "-cf", archive],
				{ input: listed },
			),
			"packing a copy of the checkout",
		)
		succeeded(await docker(["cp", archive, `${machine}:/checkout.tar`]), "copying the checkout in")
	} finally {
		rmSync(scratch, { force: true, recursive: true })
	}
	succeeded(
		await shell(
			machine,
			ROOT,
			"mkdir /checkout && tar -xf /checkout.tar -C /checkout && [ -z \"$(find /checkout -name '._*')\" ]",
		),
		"unpacking the checkout with no macOS metadata files in it",
	)
}, 600_000)

afterAll(async () => {
	await remove(machine)
})

const copyTo = async (directory: string): Promise<void> => {
	succeeded(await exec(machine, ROOT, ["cp", "-a", "/checkout", directory]), "copying the checkout")
}

const install = (directory: string): Promise<Ran> =>
	exec(machine, { user: "root", workdir: directory, timeoutMs: INSTALL_TIMEOUT_MS }, [
		"sh",
		"scripts/install.sh",
	])

const envOf = async (directory: string): Promise<Map<string, string>> =>
	new Map(
		(await read(machine, `${directory}/.env`))
			.split("\n")
			.filter((line) => /^[A-Z_]+=/.test(line))
			.map(
				(line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)] as const,
			),
	)

const whatDockerHolds = async (): Promise<string> =>
	succeeded(
		await shell(
			machine,
			ROOT,
			"docker ps --all --quiet; docker volume ls --quiet; docker image ls --quiet",
		),
		"reading what Docker holds",
	)

describe("install.sh, where a .env already exists", () => {
	it("refuses, leaving that .env and Docker exactly as they were", async () => {
		await copyTo("/refused")
		succeeded(
			await shell(
				machine,
				{ ...ROOT, input: "SEALBOX_KEYS=the only copy of it\n" },
				"cat > /refused/.env",
			),
			"writing a .env",
		)
		const before = await whatDockerHolds()

		const ran = await install("/refused")

		expect(ran.status).not.toBe(0)
		expect(ran.stderr).toContain(".env already exists")
		expect(await read(machine, "/refused/.env")).toBe("SEALBOX_KEYS=the only copy of it\n")
		expect(await whatDockerHolds()).toBe(before)
	})
})

describe("install.sh, on a machine with Docker and nothing else", () => {
	let installed: Ran = { status: null, stdout: "", stderr: "" }

	beforeAll(async () => {
		await copyTo("/fresh")
		installed = await install("/fresh")
	}, INSTALL_TIMEOUT_MS)

	it("finishes, although this machine cannot be offered as a host", async () => {
		expect(installed.status, installed.stderr).toBe(0)
		const offered = [...(await envOf("/fresh")).keys()].filter((name) =>
			name.startsWith("SELF_HOST_"),
		)
		expect(offered).toEqual([])
	})

	it("writes .env for its owner alone, holding secrets it generated and nothing for development", async () => {
		const mode = succeeded(await exec(machine, ROOT, ["stat", "-c", "%a", "/fresh/.env"]), "stat")
		expect(mode.trim()).toBe("600")
		const env = await envOf("/fresh")
		const password = env.get("POSTGRES_PASSWORD") ?? ""
		expect(password).toMatch(/^[A-Za-z0-9]{1,32}$/)
		expect(password).not.toBe("postgres")
		expect(env.get("DATABASE_URL")).toContain(`:${password}@`)
		expect(env.get("BETTER_AUTH_SECRET")).toMatch(/^[A-Za-z0-9+/]{43}=$/)
		expect(env.get("BETTER_AUTH_SECRET")).not.toBe(KNOWN_DEV_SECRET)
		expect(env.get("SEALBOX_KEYS")).toMatch(/^k1:[^:]+:[^:]+$/)
		expect(env.get("SEALBOX_KEYS")).not.toContain(KNOWN_DEV_KEY_ID)
		expect([...env.keys()].filter((name) => DEVELOPMENT_ONLY.includes(name))).toEqual([])
	})

	it("brings up a control plane that answers, on a database it migrated", async () => {
		const port = (await envOf("/fresh")).get("SERVER_PORT") ?? ""
		const answered = await shell(
			machine,
			ROOT,
			'for attempt in $(seq 1 60); do wget -qO- "http://127.0.0.1:$1/healthz" && exit 0; sleep 2; done; exit 1',
			port,
		)
		expect(answered.stdout).toContain('"ok":true')

		const services = succeeded(
			await exec(machine, ROOT, [
				"docker",
				"ps",
				"--all",
				"--filter",
				"label=com.docker.compose.project=open-mcc",
				"--format",
				'{{.Label "com.docker.compose.service"}} {{.State}} {{.Status}}',
			]),
			"listing the stack",
		)
		const states = services
			.trim()
			.split("\n")
			.map((line) => line.split(" ").slice(0, 2).join(" "))
			.sort()
		expect(states).toEqual([
			"migrate exited",
			"postgres running",
			"server running",
			"worker running",
		])
		expect(services).toMatch(/^migrate exited Exited \(0\)/m)
	})

	it("refuses a second install over the database volume the first one made", async () => {
		await copyTo("/second")

		const ran = await install("/second")

		expect(ran.status).not.toBe(0)
		expect(ran.stderr).toContain("a database volume open-mcc_pgdata already exists")
	})
})
