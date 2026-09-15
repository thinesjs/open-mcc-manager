import { spawnSync } from "node:child_process"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import type { Fields } from "@open-mcc/core"
import { describe, expect, it } from "vitest"

const APP = join(dirname(fileURLToPath(import.meta.url)), "..")

const OTLP = "OTEL_EXPORTER_OTLP_ENDPOINT is not set"

const runEntrypoint = (level: string): readonly Fields[] => {
	const result = spawnSync(join(APP, "node_modules/.bin/tsx"), ["src/index.ts"], {
		cwd: APP,
		encoding: "utf8",
		timeout: 15_000,
		env: {
			...process.env,
			LOG_LEVEL: level,
			DATABASE_URL: "postgres://nobody:nobody@127.0.0.1:1/nope",
			SEALBOX_KEYS: "k1:aaa:bbb",
			OTEL_EXPORTER_OTLP_ENDPOINT: "",
		},
	})
	return result.stdout
		.split("\n")
		.filter((line) => line.startsWith("{"))
		.map((line) => JSON.parse(line))
}

describe("the worker entrypoint as the daemon actually runs it", () => {
	it("logs its startup warning and its fatal failure through the root, stamped with the service", () => {
		const entries = runEntrypoint("warn")

		const warning = entries.find((entry) => String(entry.message).includes(OTLP))
		expect(warning?.level).toBe("warn")
		expect(warning?.service).toBe("open-mcc-worker")

		const fatal = entries.find((entry) => entry.message === "Worker failed to start")
		expect(fatal?.level).toBe("error")
		expect(fatal?.service).toBe("open-mcc-worker")
	}, 15_000)

	it("honours LOG_LEVEL=error from the real process, dropping the warning but keeping the failure", () => {
		const entries = runEntrypoint("error")

		expect(entries.filter((entry) => String(entry.message).includes(OTLP))).toEqual([])
		expect(entries.find((entry) => entry.message === "Worker failed to start")?.level).toBe("error")
	}, 15_000)
})
