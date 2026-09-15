import { spawnSync } from "node:child_process"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import type { Fields } from "@open-mcc/core"
import { describe, expect, it } from "vitest"

const APP = join(dirname(fileURLToPath(import.meta.url)), "..")

const OTLP = "OTEL_EXPORTER_OTLP_ENDPOINT is not set"

const runEntrypoint = (level: string, port: string): readonly Fields[] => {
	const result = spawnSync(join(APP, "node_modules/.bin/tsx"), ["src/index.ts"], {
		cwd: APP,
		encoding: "utf8",
		timeout: 15_000,
		env: {
			...process.env,
			LOG_LEVEL: level,
			PORT: port,
			DATABASE_URL: "postgres://nobody:nobody@127.0.0.1:1/nope",
			SEALBOX_KEYS: "k1:aaa:bbb",
			BETTER_AUTH_SECRET: "a-very-long-test-secret-value-000000",
			BETTER_AUTH_URL: "http://localhost:3000",
			ALLOWED_ORIGINS: "http://localhost:5173",
			OTEL_EXPORTER_OTLP_ENDPOINT: "",
		},
	})
	if (result.error) throw result.error
	return result.stdout
		.split("\n")
		.filter((line) => line.startsWith("{"))
		.map((line) => JSON.parse(line))
}

describe("the server entrypoint as the daemon actually runs it", () => {
	it("logs its startup warning and its fatal failure through the root, stamped with the service", () => {
		const entries = runEntrypoint("warn", "1")

		const warning = entries.find((entry) => String(entry.message).includes(OTLP))
		expect(warning?.level).toBe("warn")
		expect(warning?.service).toBe("open-mcc-server")

		const fatal = entries.filter((entry) => entry.level === "error")
		expect(fatal).toHaveLength(1)
		expect(fatal[0]?.service).toBe("open-mcc-server")
	}, 15_000)

	it("honours LOG_LEVEL=error from the real process, dropping the warning but keeping the failure", () => {
		const entries = runEntrypoint("error", "1")

		expect(entries.filter((entry) => String(entry.message).includes(OTLP))).toEqual([])
		expect(entries.filter((entry) => entry.level === "error")).toHaveLength(1)
	}, 15_000)

	it("has a root logger before env validation, because a rejected env is itself reported through it", () => {
		const entries = runEntrypoint("warn", "0")

		const rejected = entries.find((entry) => String(entry.message).includes("PORT"))
		expect(rejected?.level).toBe("error")
		expect(rejected?.service).toBe("open-mcc-server")
	}, 15_000)
})
