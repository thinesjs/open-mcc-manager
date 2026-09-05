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
		expect(base).toContain("BETTER_AUTH_SECRET: ${BETTER_AUTH_SECRET}")
		expect(base).toContain("SEALBOX_KEYS: ${SEALBOX_KEYS}")
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
})
