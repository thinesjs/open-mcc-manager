import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

const parse = (contents: string): Map<string, string> => {
	const values = new Map<string, string>()
	for (const line of contents.split("\n")) {
		const trimmed = line.trim()
		if (trimmed.length === 0 || trimmed.startsWith("#")) continue
		const separator = trimmed.indexOf("=")
		if (separator === -1) continue
		values.set(trimmed.slice(0, separator), trimmed.slice(separator + 1))
	}
	return values
}

const example = parse(readFileSync(join(ROOT, ".env.example"), "utf8"))
const compose = readFileSync(join(ROOT, "docker", "compose.yml"), "utf8")

const require_ = (key: string): string => {
	const value = example.get(key)
	if (value === undefined) throw new Error(`.env.example is missing ${key}`)
	return value
}

const portOf = (url: string): string => {
	const port = new URL(url).port
	if (port.length === 0) throw new Error(`${url} names no explicit port`)
	return port
}

describe(".env.example", () => {
	it("pins the compose project, so a later plain command cannot orphan the database", () => {
		expect(example.has("COMPOSE_PROJECT_NAME")).toBe(true)
	})

	it("names every port the compose file interpolates, so no service falls back to a default", () => {
		const names = [...compose.matchAll(/\$\{([A-Z_]*PORT)(?::-[^}]*)?\}/g)].map(
			(match) => match[1] ?? "",
		)

		expect(names.length).toBeGreaterThan(0)
		expect(names.filter((name) => !example.has(name))).toEqual([])
	})

	it("points DATABASE_URL at the port the development database publishes", () => {
		expect(portOf(require_("DATABASE_URL"))).toBe(require_("DEV_DB_PORT"))
	})

	it("points TEST_DATABASE_URL at the port the test database publishes", () => {
		expect(portOf(require_("TEST_DATABASE_URL"))).toBe(require_("TEST_DB_PORT"))
	})

	it("points BETTER_AUTH_URL at the port the server publishes", () => {
		expect(portOf(require_("BETTER_AUTH_URL"))).toBe(require_("SERVER_PORT"))
	})

	it("trusts the dashboard's own origin, or better-auth answers it 403 INVALID_ORIGIN", () => {
		expect(portOf(require_("ALLOWED_ORIGINS"))).toBe(require_("WEB_PORT"))
	})

	it("points the dashboard's dev proxy at the port the server is reachable on", () => {
		expect(portOf(require_("SERVER_ORIGIN"))).toBe(require_("SERVER_PORT"))
	})

	it("binds a locally run server on the same port the dev proxy expects", () => {
		expect(require_("PORT")).toBe(require_("SERVER_PORT"))
	})

	it("hands the server every variable that configures signing in through a provider", () => {
		const server = compose.split("\n  worker:")[0] ?? ""
		const names = ["OIDC_ISSUER_URL", "OIDC_CLIENT_ID", "OIDC_CLIENT_SECRET", "OIDC_NAME"]

		const dropped = names.filter(
			(name) => !new RegExp(`^ +${name}: \\$\\{${name}:-\\}$`, "m").test(server),
		)

		expect(dropped).toEqual([])
	})
})
