import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import {
	ASSET_REFERENCE,
	assetRefusal,
	DATABASE_HOST_ALIAS,
	DATABASE_URL_VARIABLE,
	describeExit,
	emptinessRefusal,
	healthRefusal,
	httpAttempt,
	IMAGES,
	liveAttempt,
	POSTGRES_CLIENT_IMAGE,
	pollFor,
	PROBE_ATTEMPTS,
	RELATION_COUNT_QUERY,
	scheduleRefusal,
	SEALBOX_KEY_ID,
	SERVER_PORT,
	SHELL_MARKER,
	shellRefusal,
	smoke,
	stateOf,
	tagFor,
	runArgs,
	WEB_PORT,
} from "./smoke-images.mjs"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

const workflow = (name: string): string =>
	readFileSync(join(ROOT, ".github", "workflows", name), "utf8")

const RELEASE = workflow("release.yml")

const CI = workflow("ci.yml")

const SMOKE = workflow("image-smoke.yml")

const REUSABLE = "uses: ./.github/workflows/image-smoke.yml"

type Covered = { image: string; dockerfile: string; target: string }

const matrixImages = (release: string): Covered[] =>
	[...release.matchAll(/- image: (\S+)\n\s+dockerfile: (\S+)\n\s+target: (\S+)/g)].map(
		(match) => ({
			image: match[1] ?? "",
			dockerfile: match[2] ?? "",
			target: match[3] ?? "",
		}),
	)

const buildSteps = (smokeWorkflow: string): Map<string, string> => {
	const found = new Map<string, string>()
	for (const chunk of smokeWorkflow.split("- name: Build ").slice(1)) {
		const next = chunk.search(/\n\s+- name: /)
		found.set(chunk.split("\n")[0]?.trim() ?? "", next === -1 ? chunk : chunk.slice(0, next))
	}
	return found
}

const callerJobIn = (text: string): string | undefined =>
	new RegExp(`^ {2}(\\S+):\\n {4}${REUSABLE.replace(/[.*+?^$()|[\]\\]/g, "\\$&")}$`, "m").exec(
		text,
	)?.[1]

type DockerResult = { status: number; stdout: string; stderr: string }

const ok = (stdout: string): DockerResult => ({ status: 0, stdout, stderr: "" })

const MODULE_NOT_FOUND =
	"Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@opentelemetry/api' imported from /app/node_modules/pg-boss/dist/telemetry.js"

const SHELL = `<!doctype html><html><body>${SHELL_MARKER}<script type="module" src="/assets/index-abc123.js"></script></body></html>`

const HEALTHY = '{"ok":true,"version":"0.0.0-dev","commit":"unknown"}'

const KNOWN = new Set([...IMAGES.map((each: Covered) => tagFor(each.image)), POSTGRES_CLIENT_IMAGE])

const DATABASE_URL = `postgres://postgres:postgres@${DATABASE_HOST_ALIAS}:55432/postgres`

type MachineOptions = {
	broken?: readonly string[]
	relations?: string
	schedules?: string
	health?: { status: number; body: string }
	shell?: string
	assetStatus?: number
	stopExitCode?: string
}

const machine = (options: MachineOptions = {}) => {
	const broken = new Set((options.broken ?? []).map(tagFor))
	const dead = new Set<string>()
	const stopped = new Set<string>()
	const said: string[] = []
	const calls: string[][] = []

	const docker = (args: readonly string[]): DockerResult => {
		calls.push([...args])
		const verb = args[0]
		const last = args[args.length - 1] ?? ""
		if (verb === "rm" || verb === "logs") return ok("")
		if (verb === "stop") {
			stopped.add(last)
			return ok("")
		}
		if (verb === "inspect") {
			if (dead.has(last)) return ok("false 1")
			return ok(stopped.has(last) ? `false ${options.stopExitCode ?? "0"}` : "true 0")
		}
		const image = args.find((arg) => KNOWN.has(arg)) ?? ""
		if (image === POSTGRES_CLIENT_IMAGE) {
			if (last === RELATION_COUNT_QUERY) return ok(options.relations ?? "0")
			return ok(options.schedules ?? "3")
		}
		if (broken.has(image)) {
			if (args.includes("-d")) {
				dead.add(args[args.indexOf("--name") + 1] ?? "")
				return ok("deadbeef\n")
			}
			return { status: 1, stdout: "", stderr: MODULE_NOT_FOUND }
		}
		if (args.includes("--generate-sealbox-key")) return ok(`${SEALBOX_KEY_ID}:public:private\n`)
		return ok("")
	}

	const fetchFn = async (url: string) => {
		if (url.endsWith("/healthz")) {
			const health = options.health ?? { status: 200, body: HEALTHY }
			return { status: health.status, text: async () => health.body }
		}
		if (url.includes("/assets/")) {
			return { status: options.assetStatus ?? 200, text: async () => "export{}" }
		}
		return { status: 200, text: async () => options.shell ?? SHELL }
	}

	const deps = {
		docker,
		fetchFn,
		wait: async () => undefined,
		say: (line: string) => said.push(line),
	}
	return { deps, said, calls }
}

const refusalFrom = async (options: MachineOptions): Promise<string> => {
	const { deps } = machine(options)
	try {
		await smoke(deps, DATABASE_URL)
	} catch (error) {
		return error instanceof Error ? error.message : String(error)
	}
	return "it passed"
}

describe("the images the gate covers", () => {
	it("★ covers exactly what the release workflow publishes", () => {
		expect(matrixImages(RELEASE)).toEqual(
			expect.arrayContaining(IMAGES.map((each: Covered) => ({ ...each }))),
		)
		expect(matrixImages(RELEASE)).toHaveLength(IMAGES.length)
	})

	it("★ reads four images out of the release matrix, so an empty parse would not pass", () => {
		expect(matrixImages(RELEASE).length).toBeGreaterThan(3)
	})

	it("★ builds every covered image under the tag the prober runs", () => {
		const steps = buildSteps(SMOKE)
		for (const { image, dockerfile, target } of IMAGES) {
			const step = steps.get(image) ?? ""
			expect(step, image).toContain(`file: ${dockerfile}`)
			expect(step, image).toContain(`target: ${target}`)
			expect(step, image).toContain(`tags: ${tagFor(image)}`)
			expect(step, image).toContain("load: true")
			expect(step, image).toContain(`type=gha,scope=${image}\n`)
		}
	})

	it("★ runs the prober after those builds", () => {
		expect(SMOKE).toContain("run: node scripts/smoke-images.mjs")
	})

	it("★ points the containers at the host gateway, never at a loopback they would own", () => {
		const [, url] = /SMOKE_DATABASE_URL: (\S+)/.exec(SMOKE) ?? []
		expect(url).toContain(DATABASE_HOST_ALIAS)
		expect(url).not.toContain("localhost")
		expect(url).not.toContain("127.0.0.1")
	})
})

describe("where the gate runs", () => {
	it("★ runs on the pull and push paths that gate main", () => {
		expect(CI).toContain(REUSABLE)
		expect(CI).toContain("pull_request")
		expect(CI).toContain("branches: [main]")
	})

	it("★ stands between a tag and the images it would publish", () => {
		const caller = callerJobIn(RELEASE)
		expect(caller).toBeDefined()
		expect(/^ {2}publish:\n {4}needs: (\S+)$/m.exec(RELEASE)?.[1]).toBe(caller)
	})
})

describe("the docker arguments the prober builds", () => {
	it("★ resolves the database through the host gateway from inside the container", () => {
		expect(runArgs({ name: "a", image: "b" })).toContain(`${DATABASE_HOST_ALIAS}:host-gateway`)
	})

	it("★ publishes a probed port on loopback alone", () => {
		expect(runArgs({ name: "a", image: "b", publish: [SERVER_PORT] })).toContain(
			`127.0.0.1:${SERVER_PORT}:${SERVER_PORT}`,
		)
	})

	it("★ passes each environment entry as its own -e pair", () => {
		expect(runArgs({ name: "a", image: "b", env: { PORT: String(WEB_PORT) } })).toEqual(
			expect.arrayContaining(["-e", `PORT=${WEB_PORT}`]),
		)
	})

	it("★ names the image last, so a command follows it rather than preceding it", () => {
		expect(runArgs({ name: "a", image: "b", command: ["c"] }).slice(-2)).toEqual(["b", "c"])
	})
})

describe("giving up rather than reporting success having waited", () => {
	it("★ reports the last refusal and how many attempts it made", async () => {
		const outcome = await pollFor(async () => ({ ok: false, detail: "nothing yet" }), {
			attempts: 3,
			delayMs: 0,
			wait: async () => undefined,
		})
		expect(outcome.ok).toBe(false)
		expect(outcome.detail).toBe("nothing yet, still after 3 attempts")
	})

	it("★ cannot pass having attempted nothing", async () => {
		const outcome = await pollFor(async () => ({ ok: true }), {
			attempts: 0,
			delayMs: 0,
			wait: async () => undefined,
		})
		expect(outcome.ok).toBe(false)
	})

	it("★ stops at a fatal outcome rather than waiting out every attempt", async () => {
		let attempts = 0
		const outcome = await pollFor(
			async () => {
				attempts += 1
				return { ok: false, fatal: true, detail: "it died" }
			},
			{ attempts: 10, delayMs: 0, wait: async () => undefined },
		)
		expect([attempts, outcome.detail]).toEqual([1, "it died"])
	})

	it("★ returns the first success and waits no further", async () => {
		let attempts = 0
		const outcome = await pollFor(
			async () => {
				attempts += 1
				return attempts === 2 ? { ok: true, body: "up" } : { ok: false, detail: "not yet" }
			},
			{ attempts: 10, delayMs: 0, wait: async () => undefined },
		)
		expect([attempts, outcome.body]).toEqual([2, "up"])
	})
})

describe("reading a container's state", () => {
	it("★ reads a running container and its exit code apart", () => {
		expect(stateOf("a", () => ok("true 0"))).toEqual({ running: true, exitCode: 0 })
	})

	it("★ reads a container that crashed", () => {
		expect(stateOf("a", () => ok("false 1"))).toEqual({ running: false, exitCode: 1 })
	})

	it("★ says a container docker cannot find is gone rather than exited NaN", () => {
		expect(describeExit(stateOf("a", () => ok("")).exitCode)).toBe("is gone")
	})

	it("★ treats a crashed container as fatal, naming its exit code", async () => {
		const outcome = await liveAttempt("a", async () => ({ ok: true }), () => ok("false 1"))()
		expect(outcome.fatal).toBe(true)
		expect(outcome.detail).toContain("a exited 1 while starting")
	})

	it("★ only probes a container that is still running", async () => {
		let probed = 0
		await liveAttempt(
			"a",
			async () => {
				probed += 1
				return { ok: true }
			},
			() => ok("false 1"),
		)()
		expect(probed).toBe(0)
	})
})

describe("what an answer has to carry before it counts", () => {
	it("★ refuses a status other than 200", async () => {
		const outcome = await httpAttempt("http://host/healthz", healthRefusal, async () => ({
			status: 503,
			text: async () => HEALTHY,
		}))()
		expect(outcome.detail).toContain("answered 503")
	})

	it("★ refuses a 200 that does not report ok", async () => {
		const outcome = await httpAttempt("http://host/healthz", healthRefusal, async () => ({
			status: 200,
			text: async () => '{"ok":false}',
		}))()
		expect(outcome.detail).toContain("did not report ok")
	})

	it("★ refuses a connection that never answered", async () => {
		const outcome = await httpAttempt("http://host/healthz", healthRefusal, async () => {
			throw new Error("ECONNREFUSED")
		})()
		expect(outcome.detail).toContain("ECONNREFUSED")
	})

	it("★ accepts the healthz body the server actually sends", async () => {
		const outcome = await httpAttempt("http://host/healthz", healthRefusal, async () => ({
			status: 200,
			text: async () => HEALTHY,
		}))()
		expect(outcome).toEqual({ ok: true, body: HEALTHY })
	})

	it("★ reads the dashboard shell and the module it references", () => {
		expect([shellRefusal(SHELL), assetRefusal(SHELL)]).toEqual([undefined, undefined])
		expect(ASSET_REFERENCE.exec(SHELL)?.[1]).toBe("/assets/index-abc123.js")
	})

	it("★ refuses a page the image served without the dashboard in it", () => {
		expect(shellRefusal("<html><body>not found</body></html>")).toContain(SHELL_MARKER)
	})

	it("★ refuses a shell that references no hashed module, which an empty dist would serve", () => {
		expect(assetRefusal(`<html><body>${SHELL_MARKER}</body></html>`)).toContain("/assets")
	})

	it("★ refuses a database pg-boss has not written to yet", () => {
		expect(scheduleRefusal("0")).toContain("registered no schedule")
		expect(scheduleRefusal('ERROR:  schema "pgboss" does not exist')).toContain("no schema yet")
		expect(scheduleRefusal("3")).toBeUndefined()
	})

	it("★ refuses a database already carrying relations, where no signal would be the images' own", () => {
		expect(emptinessRefusal("181")).toContain("181 relations")
		expect(emptinessRefusal("could not connect")).toContain("could not be counted")
		expect(emptinessRefusal("0")).toBeUndefined()
	})
})

describe("the gate against the failure that took production down", () => {
	it("★ passes when every image starts", async () => {
		const { deps, said } = machine()
		await smoke(deps, DATABASE_URL)
		expect(said.join("\n")).toContain("/healthz answered")
		expect(said.join("\n")).toContain("registered a schedule")
		expect(said.join("\n")).toContain("served the shell")
	})

	it("★ fails on a server image whose undeclared import was pruned away", async () => {
		const refusal = await refusalFrom({ broken: ["open-mcc-server"] })
		expect(refusal).toContain("could not generate a sealbox key")
		expect(refusal).toContain("Cannot find package '@opentelemetry/api'")
	})

	it("★ fails on a worker image that dies the same way, where no port is listening", async () => {
		const refusal = await refusalFrom({ broken: ["open-mcc-worker"] })
		expect(refusal).toContain("open-mcc-worker-smoke exited 1 while starting")
	})

	it("★ fails on a web image that dies, which no bundling check would see", async () => {
		const refusal = await refusalFrom({ broken: ["open-mcc-web"] })
		expect(refusal).toContain("open-mcc-web-smoke exited 1 while starting")
	})

	it("★ fails on a migrate image that will not run", async () => {
		const refusal = await refusalFrom({ broken: ["open-mcc-migrate"] })
		expect(refusal).toContain("instead of applying the schema")
	})

	it("★ fails on a server that starts and never answers healthz", async () => {
		const refusal = await refusalFrom({ health: { status: 500, body: "" } })
		expect(refusal).toContain("never answered /healthz")
		expect(refusal).toContain(`still after ${PROBE_ATTEMPTS} attempts`)
	})

	it("★ fails on a worker that starts and never finishes starting", async () => {
		const refusal = await refusalFrom({ schedules: "0" })
		expect(refusal).toContain("never finished starting")
	})

	it("★ fails on a worker killed by SIGTERM before its own shutdown handler was armed", async () => {
		const refusal = await refusalFrom({ stopExitCode: "143" })
		expect(refusal).toContain("exited 143 on SIGTERM")
	})

	it("★ fails on a web image serving a shell whose module is missing", async () => {
		const refusal = await refusalFrom({ assetStatus: 404 })
		expect(refusal).toContain("serves a shell whose module is missing")
	})

	it("★ refuses a database it was not given", async () => {
		const { deps } = machine({ relations: "181" })
		await expect(smoke(deps, DATABASE_URL)).rejects.toThrow(DATABASE_URL_VARIABLE)
	})

	it("★ removes every container it named, on the failing path as well", async () => {
		const { deps, calls } = machine({ broken: ["open-mcc-web"] })
		await expect(smoke(deps, DATABASE_URL)).rejects.toThrow()
		for (const { image } of IMAGES) {
			expect(calls.filter((args) => args[0] === "rm" && args[2] === `${image}-smoke`)).toHaveLength(
				2,
			)
		}
	})
})
