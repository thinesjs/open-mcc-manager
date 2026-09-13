import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const read = (name: string) => readFileSync(join(ROOT, "docker", name), "utf8")

const base = read("compose.yml")
const dev = read("compose.dev.yml")

const KNOWN_DEV_KEY_ID = "dev-insecure-publicly-known"
const KNOWN_DEV_SECRET = "dev-only-secret-change-me-before-any-real-deploy"

describe("the compose file a real deployment uses", () => {
	it("carries no sealbox key of its own, so no two installs share one", () => {
		expect(base).not.toContain(KNOWN_DEV_KEY_ID)
	})

	it("carries no session secret of its own", () => {
		expect(base).not.toContain(KNOWN_DEV_SECRET)
	})

	it("takes both secrets from the environment rather than hardcoding them", () => {
		for (const name of ["BETTER_AUTH_SECRET", "SEALBOX_KEYS"]) {
			expect(new RegExp(`${name}: \\$\\{${name}\\}`).test(base)).toBe(true)
		}
	})

	it("names its own compose project, so it cannot adopt an unrelated stack's containers", () => {
		expect(base.startsWith("name:")).toBe(true)
		expect(base).toContain("open-mcc")
	})

	it("keeps the insecure development values in an overlay that must be asked for", () => {
		expect(dev).toContain(KNOWN_DEV_KEY_ID)
		expect(dev).toContain(KNOWN_DEV_SECRET)
	})

	it("gives no secret a default, so an unset one fails closed instead of falling back", () => {
		const SECRETS = ["POSTGRES_PASSWORD", "BETTER_AUTH_SECRET", "SEALBOX_KEYS"]
		const defaulted = SECRETS.filter((name) => new RegExp(`\\$\\{${name}:[-?]`).test(base))

		expect(defaulted).toEqual([])
	})

	it("interpolates every database password rather than writing one in", () => {
		expect(base.match(/postgres:[^$@\s]+@/g) ?? []).toEqual([])
		expect(base.match(/^\s*POSTGRES_PASSWORD: (?!\$\{)/gm) ?? []).toEqual([])
	})

	it("keeps the ephemeral test database out of a real deployment", () => {
		expect(base).not.toContain("postgres-test")
		expect(dev).toContain("postgres-test")
	})

	it("bundles no database at all, so a real deployment points at its own", () => {
		expect(base).not.toContain("image: postgres:17")
		expect(base).not.toContain("pgdata")
		expect(dev).toContain("image: postgres:17")
		expect(dev).toContain("pgdata")
	})

	it("takes the database address whole from the environment, never assembling one", () => {
		expect(base).toContain("DATABASE_URL: ${DATABASE_URL}")
		expect(base).not.toContain("@postgres:5432")
	})

	it("never migrates from the build stage, which ships the whole toolchain", () => {
		expect(base).not.toContain("target: build")
		expect(base).toContain("target: migrate")
	})

	it("pins the server to the runtime stage, so a new last stage cannot silently become it", () => {
		expect(base).toContain("target: runtime")
	})

	it("gives the two settings that break a deployment no default to hide behind", () => {
		for (const name of ["ALLOWED_ORIGINS", "BETTER_AUTH_URL"]) {
			expect(new RegExp(`${name}: \\$\\{${name}\\}`).test(base), name).toBe(true)
			expect(new RegExp(`\\$\\{${name}:[-?]`).test(base), name).toBe(false)
		}
	})
})

const daemonBlock = (service: string): string => {
	const start = base.indexOf(`\n  ${service}:`)
	const rest = base.slice(start + 1)
	const next = rest.search(/\n {2}[a-z][a-z-]*:\n/)
	return next === -1 ? rest : rest.slice(0, next)
}

describe("what the compose file forwards to the daemons that read it", () => {
	it.each([{ service: "server" }, { service: "worker" }])(
		"gives $service the log level, or an operator setting it in .env would be silently ignored",
		({ service }) => {
			expect(daemonBlock(service)).toContain("LOG_LEVEL: ${LOG_LEVEL:-info}")
		},
	)

	it.each([{ service: "server" }, { service: "worker" }])(
		"gives $service the tracing endpoint, or traces would be unreachable through this deployment",
		({ service }) => {
			expect(daemonBlock(service)).toContain(
				"OTEL_EXPORTER_OTLP_ENDPOINT: ${OTEL_EXPORTER_OTLP_ENDPOINT:-}",
			)
		},
	)

	it.each([{ name: "LOG_LEVEL" }, { name: "OTEL_EXPORTER_OTLP_ENDPOINT" }])(
		"documents $name in .env.example, so an operator can discover it",
		({ name }) => {
			expect(readFileSync(join(ROOT, ".env.example"), "utf8")).toMatch(new RegExp(`^${name}=`, "m"))
		},
	)
})

const SELF_HOST_FIELDS = [
	"SELF_HOST_NAME",
	"SELF_HOST_HOSTNAME",
	"SELF_HOST_PORT",
	"SELF_HOST_USERNAME",
	"SELF_HOST_MODE",
	"SELF_HOST_FINGERPRINT",
	"SELF_HOST_PUBLIC_KEY",
	"SELF_HOST_PRIVATE_KEY_SEALED",
	"SELF_HOST_PRIVATE_KEY_ID",
	"SELF_HOST_REACH",
	"SELF_HOST_SYSTEMD",
	"SELF_HOST_LINGER",
] as const

describe("what the compose file passes in for the machine it runs on", () => {
	it.each(SELF_HOST_FIELDS.map((name) => ({ name })))(
		"forwards $name to the server, the only container that reads from the host filesystem through env",
		({ name }) => {
			expect(daemonBlock("server")).toContain(`${name}: \${${name}:-}`)
		},
	)

	it.each(SELF_HOST_FIELDS.map((name) => ({ name })))(
		"keeps $name out of the worker, which never enrolls a host",
		({ name }) => {
			expect(daemonBlock("worker")).not.toContain(name)
		},
	)

	it("lets an unset self-host install come up, rather than failing closed on a missing address", () => {
		const required = SELF_HOST_FIELDS.filter((name) =>
			new RegExp(`${name}: \\$\\{${name}\\}`).test(base),
		)

		expect(required).toEqual([])
	})

	it.each([{ service: "server" }, { service: "worker" }])(
		"gives $service a name for the machine it runs on, which native Docker Engine does not resolve by itself",
		({ service }) => {
			expect(daemonBlock(service)).toContain('- "host.docker.internal:host-gateway"')
		},
	)
})

describe("the database the installer brings with it", () => {
	const installerDatabase = read("compose.postgres.yml")
	const installer = readFileSync(join(ROOT, "scripts", "install.sh"), "utf8")

	it("gives its password no default, so an unset one fails closed", () => {
		expect(installerDatabase).toContain("POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}")
		expect(installerDatabase).not.toMatch(/\$\{POSTGRES_PASSWORD:[-?]/)
	})

	it("publishes no port, because nothing outside the stack talks to it", () => {
		expect(installerDatabase).not.toMatch(/^\s*ports:/m)
	})

	it("leaves the database address to the environment, whole", () => {
		expect(installerDatabase).not.toContain("DATABASE_URL")
		expect(installer).toContain(
			"DATABASE_URL=postgres://postgres:$POSTGRES_PASSWORD@postgres:5432/open_mcc_manager",
		)
	})

	it("is part of every compose call the installer makes", () => {
		const calls = installer
			.split("\n")
			.filter((line) => line.includes("docker compose") && line.includes("-f docker/compose.yml"))

		expect(calls.length).toBeGreaterThan(0)
		expect(calls.filter((line) => !line.includes("-f docker/compose.postgres.yml"))).toEqual([])
	})

	it("writes nothing only development reads into a real deployment's .env", () => {
		for (const name of ["DEV_DB_PORT", "TEST_DB_PORT", "TEST_DATABASE_URL"]) {
			expect(installer, name).not.toContain(`${name}=`)
		}
	})
})
