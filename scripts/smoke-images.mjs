import { spawnSync } from "node:child_process"

export const DATABASE_URL_VARIABLE = "SMOKE_DATABASE_URL"

export const DATABASE_HOST_ALIAS = "host.docker.internal"

export const POSTGRES_CLIENT_IMAGE = "postgres:17"

export const SEALBOX_KEY_ID = "smoke"

export const BETTER_AUTH_SECRET = "smoke-only-not-a-real-secret"

export const SERVER_PORT = 3000

export const WEB_PORT = 3100

export const SHELL_MARKER = '<div id="root"></div>'

export const ASSET_REFERENCE = /src="(\/assets\/[^"]+\.js)"/

export const PROBE_ATTEMPTS = 90

export const PROBE_DELAY_MS = 1_000

export const STOP_TIMEOUT_SECONDS = 30

export const SCHEDULE_COUNT_QUERY = "select count(*) from pgboss.schedule"

export const RELATION_COUNT_QUERY =
	"select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname in ('public', 'pgboss')"

export const IMAGES = [
	{ image: "open-mcc-migrate", dockerfile: "docker/server/Dockerfile", target: "migrate" },
	{ image: "open-mcc-server", dockerfile: "docker/server/Dockerfile", target: "runtime" },
	{ image: "open-mcc-worker", dockerfile: "docker/worker/Dockerfile", target: "runtime" },
	{ image: "open-mcc-web", dockerfile: "docker/web/Dockerfile", target: "runtime" },
]

export const tagFor = (image) => `smoke/${image}:local`

export const containerFor = (image) => `${image}-smoke`

export const sleep = (ms) =>
	new Promise((resolve) => {
		setTimeout(resolve, ms)
	})

const defaultDocker = (args) =>
	spawnSync("docker", args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 })

export const runArgs = (options) => {
	const publish = options.publish ?? []
	const env = options.env ?? {}
	const command = options.command ?? []
	return [
		"run",
		...(options.detached === true ? ["-d"] : []),
		...(options.remove === true ? ["--rm"] : []),
		"--name",
		options.name,
		"--add-host",
		`${DATABASE_HOST_ALIAS}:host-gateway`,
		...publish.flatMap((port) => ["-p", `127.0.0.1:${port}:${port}`]),
		...Object.entries(env).flatMap(([key, value]) => ["-e", `${key}=${value}`]),
		options.image,
		...command,
	]
}

export const outputOf = (result) => `${result.stdout ?? ""}${result.stderr ?? ""}`

export const stateOf = (name, docker) => {
	const result = docker(["inspect", "-f", "{{.State.Running}} {{.State.ExitCode}}", name])
	const [running, code] = outputOf(result).trim().split(" ")
	return { running: running === "true", exitCode: Number.parseInt(code ?? "", 10) }
}

export const pollFor = async (attempt, { attempts, delayMs, wait }) => {
	let last = { ok: false, fatal: false, detail: "nothing was attempted", body: "" }
	for (let index = 0; index < attempts; index += 1) {
		last = await attempt()
		if (last.ok === true || last.fatal === true) return last
		await wait(delayMs)
	}
	return { ...last, ok: false, detail: `${last.detail}, still after ${attempts} attempts` }
}

export const httpAttempt = (url, refusalIn, fetchFn) => async () => {
	let response
	try {
		response = await fetchFn(url)
	} catch (error) {
		return { ok: false, detail: `${url} did not answer: ${error.message}` }
	}
	const body = await response.text()
	if (response.status !== 200) return { ok: false, detail: `${url} answered ${response.status}` }
	const refusal = refusalIn(body)
	if (refusal !== undefined) return { ok: false, detail: `${url} answered 200 but ${refusal}` }
	return { ok: true, body }
}

export const describeExit = (exitCode) =>
	Number.isNaN(exitCode) ? "is gone" : `exited ${exitCode}`

export const liveAttempt = (name, attempt, docker) => async () => {
	const state = stateOf(name, docker)
	if (!state.running) {
		return {
			ok: false,
			fatal: true,
			detail: `${name} ${describeExit(state.exitCode)} while starting`,
		}
	}
	return await attempt()
}

export const healthRefusal = (body) =>
	body.includes('"ok":true') ? undefined : `did not report ok: ${body.slice(0, 200)}`

export const shellRefusal = (body) =>
	body.includes(SHELL_MARKER) ? undefined : `did not carry ${SHELL_MARKER}`

export const assetRefusal = (body) =>
	ASSET_REFERENCE.test(body) ? undefined : "referenced no hashed module from /assets"

export const scheduleRefusal = (output) => {
	const count = Number.parseInt(output.trim(), 10)
	if (Number.isNaN(count))
		return `pg-boss had written no schema yet: ${output.trim().slice(0, 200)}`
	return count > 0 ? undefined : "pg-boss had registered no schedule"
}

export const emptinessRefusal = (output) => {
	const count = Number.parseInt(output.trim(), 10)
	if (Number.isNaN(count)) return `could not be counted: ${output.trim().slice(0, 200)}`
	if (count === 0) return undefined
	return `already carries ${count} relations, so nothing these images write could be told from what was there`
}

export class SmokeFailure extends Error {}

const failWith = (detail, logs) => {
	throw new SmokeFailure(logs.trim().length > 0 ? `${detail}\n${logs}` : detail)
}

export const serverEnvironment = (databaseUrl, sealboxKeys) => ({
	DATABASE_URL: databaseUrl,
	SEALBOX_KEYS: sealboxKeys,
	BETTER_AUTH_SECRET,
	BETTER_AUTH_URL: `http://127.0.0.1:${SERVER_PORT}`,
	ALLOWED_ORIGINS: `http://127.0.0.1:${SERVER_PORT}`,
	PORT: String(SERVER_PORT),
})

export const workerEnvironment = (databaseUrl, sealboxKeys) => ({
	DATABASE_URL: databaseUrl,
	SEALBOX_KEYS: sealboxKeys,
})

const removeContainers = (docker) => {
	for (const { image } of IMAGES) docker(["rm", "-f", containerFor(image)])
}

const generateSealboxKeys = ({ docker, say }) => {
	const image = tagFor("open-mcc-server")
	say(`${image}: generating a sealbox key through the image's own --generate-sealbox-key`)
	const result = docker([
		"run",
		"--rm",
		image,
		"server.mjs",
		"--generate-sealbox-key",
		SEALBOX_KEY_ID,
	])
	const entry = (result.stdout ?? "").trim()
	if (result.status !== 0 || !entry.startsWith(`${SEALBOX_KEY_ID}:`)) {
		failWith(`${image} could not generate a sealbox key`, outputOf(result))
	}
	return entry
}

const applyMigrations = ({ docker, say }, databaseUrl) => {
	const image = tagFor("open-mcc-migrate")
	const name = containerFor("open-mcc-migrate")
	say(`${image}: applying the schema to ${DATABASE_HOST_ALIAS}`)
	const result = docker(runArgs({ name, image, env: { DATABASE_URL: databaseUrl }, remove: true }))
	if (result.status !== 0) {
		failWith(`${image} exited ${result.status} instead of applying the schema`, outputOf(result))
	}
}

const bootServer = async ({ docker, fetchFn, wait, say }, databaseUrl, sealboxKeys) => {
	const image = tagFor("open-mcc-server")
	const name = containerFor("open-mcc-server")
	say(`${image}: booting and waiting for GET /healthz`)
	const started = docker(
		runArgs({
			name,
			image,
			detached: true,
			publish: [SERVER_PORT],
			env: serverEnvironment(databaseUrl, sealboxKeys),
		}),
	)
	if (started.status !== 0) failWith(`${image} would not start`, outputOf(started))

	const url = `http://127.0.0.1:${SERVER_PORT}/healthz`
	const ready = await pollFor(liveAttempt(name, httpAttempt(url, healthRefusal, fetchFn), docker), {
		attempts: PROBE_ATTEMPTS,
		delayMs: PROBE_DELAY_MS,
		wait,
	})
	if (!ready.ok) failWith(`${image} never answered /healthz: ${ready.detail}`, logsOf(name, docker))
	say(`${image}: /healthz answered ${ready.body.trim()}`)
}

const bootWorker = async ({ docker, wait, say }, databaseUrl, sealboxKeys) => {
	const image = tagFor("open-mcc-worker")
	const name = containerFor("open-mcc-worker")
	say(`${image}: booting and waiting for pg-boss to carry a schedule`)
	const started = docker(
		runArgs({
			name,
			image,
			detached: true,
			env: workerEnvironment(databaseUrl, sealboxKeys),
		}),
	)
	if (started.status !== 0) failWith(`${image} would not start`, outputOf(started))

	const scheduled = await pollFor(
		liveAttempt(name, async () => scheduleAttempt(databaseUrl, docker), docker),
		{ attempts: PROBE_ATTEMPTS, delayMs: PROBE_DELAY_MS, wait },
	)
	if (!scheduled.ok) {
		failWith(`${image} never finished starting: ${scheduled.detail}`, logsOf(name, docker))
	}

	docker(["stop", "-t", String(STOP_TIMEOUT_SECONDS), name])
	const stopped = stateOf(name, docker)
	if (stopped.exitCode !== 0) {
		failWith(
			`${image} ${describeExit(stopped.exitCode)} on SIGTERM, so it never reached its own shutdown handler`,
			logsOf(name, docker),
		)
	}
	say(`${image}: registered a schedule and shut down on SIGTERM with exit 0`)
}

const query = (databaseUrl, sql, docker) =>
	outputOf(
		docker([
			"run",
			"--rm",
			"--add-host",
			`${DATABASE_HOST_ALIAS}:host-gateway`,
			POSTGRES_CLIENT_IMAGE,
			"psql",
			databaseUrl,
			"-tAc",
			sql,
		]),
	)

const scheduleAttempt = (databaseUrl, docker) => {
	const refusal = scheduleRefusal(query(databaseUrl, SCHEDULE_COUNT_QUERY, docker))
	return refusal === undefined ? { ok: true } : { ok: false, detail: refusal }
}

const requireEmptyDatabase = ({ docker, say }, databaseUrl) => {
	const refusal = emptinessRefusal(query(databaseUrl, RELATION_COUNT_QUERY, docker))
	if (refusal !== undefined) failWith(`${DATABASE_URL_VARIABLE} ${refusal}`, "")
	say(`${DATABASE_URL_VARIABLE}: an empty database, so every signal below is the images' own`)
}

const bootWeb = async ({ docker, fetchFn, wait, say }) => {
	const image = tagFor("open-mcc-web")
	const name = containerFor("open-mcc-web")
	say(`${image}: booting and waiting for the dashboard shell`)
	const started = docker(
		runArgs({
			name,
			image,
			detached: true,
			publish: [WEB_PORT],
			env: { PORT: String(WEB_PORT) },
		}),
	)
	if (started.status !== 0) failWith(`${image} would not start`, outputOf(started))

	const origin = `http://127.0.0.1:${WEB_PORT}`
	const shell = await pollFor(
		liveAttempt(
			name,
			httpAttempt(origin, (body) => shellRefusal(body) ?? assetRefusal(body), fetchFn),
			docker,
		),
		{ attempts: PROBE_ATTEMPTS, delayMs: PROBE_DELAY_MS, wait },
	)
	if (!shell.ok) failWith(`${image} never served the shell: ${shell.detail}`, logsOf(name, docker))

	const asset = ASSET_REFERENCE.exec(shell.body)?.[1] ?? ""
	const served = await httpAttempt(`${origin}${asset}`, () => undefined, fetchFn)()
	if (!served.ok) {
		failWith(
			`${image} serves a shell whose module is missing: ${served.detail}`,
			logsOf(name, docker),
		)
	}
	say(`${image}: served the shell and ${asset}`)
}

const logsOf = (name, docker) => outputOf(docker(["logs", "--tail", "60", name]))

export const smoke = async (deps, databaseUrl) => {
	removeContainers(deps.docker)
	try {
		requireEmptyDatabase(deps, databaseUrl)
		const sealboxKeys = generateSealboxKeys(deps)
		applyMigrations(deps, databaseUrl)
		await bootServer(deps, databaseUrl, sealboxKeys)
		await bootWorker(deps, databaseUrl, sealboxKeys)
		await bootWeb(deps)
	} finally {
		removeContainers(deps.docker)
	}
}

const main = async () => {
	const databaseUrl = process.env[DATABASE_URL_VARIABLE] ?? ""
	if (databaseUrl.trim().length === 0) {
		console.error(
			`${DATABASE_URL_VARIABLE} must carry a connection string the containers can reach, naming ${DATABASE_HOST_ALIAS} rather than localhost`,
		)
		process.exit(1)
	}
	const deps = {
		docker: defaultDocker,
		fetchFn: fetch,
		wait: sleep,
		say: (line) => process.stdout.write(`${line}\n`),
	}
	try {
		await smoke(deps, databaseUrl)
	} catch (error) {
		console.error(error.message)
		process.exit(1)
	}
	process.stdout.write("every published image started\n")
}

if (process.argv[1]?.endsWith("smoke-images.mjs")) await main()
