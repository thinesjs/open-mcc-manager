import { describe, expect, it } from "vitest"
import { createRootLogger } from "./logger"

const rootFor = (service: string, level: string | undefined) => {
	const lines: string[] = []
	const logger = createRootLogger(service, { LOG_LEVEL: level }, { write: (l) => lines.push(l) })
	return { lines, logger }
}

describe("the root logger a daemon builds from its own environment", () => {
	it.each([
		{ service: "open-mcc-worker", level: "info", visible: true },
		{ service: "open-mcc-worker", level: "warn", visible: false },
	])(
		"the worker info line at LOG_LEVEL=$level is emitted: $visible",
		({ service, level, visible }) => {
			const { lines, logger } = rootFor(service, level)

			logger.info("Removed 3 notifications past retention")

			expect(lines).toHaveLength(visible ? 1 : 0)
		},
	)

	it.each([
		{ service: "open-mcc-server", level: "warn", visible: true },
		{ service: "open-mcc-server", level: "error", visible: false },
	])(
		"the server warn line at LOG_LEVEL=$level is emitted: $visible",
		({ service, level, visible }) => {
			const { lines, logger } = rootFor(service, level)

			logger.warn("WARNING: SEALBOX_KEYS uses the publicly known development key.")

			expect(lines).toHaveLength(visible ? 1 : 0)
		},
	)

	it.each([{ service: "open-mcc-server" }, { service: "open-mcc-worker" }])(
		"stamps $service on every line, so the two daemons cannot be confused",
		({ service }) => {
			const { lines, logger } = rootFor(service, "info")

			logger.info("a line")

			expect(JSON.parse(lines[0] ?? "{}").service).toBe(service)
		},
	)

	it.each([
		{ label: "absent", level: undefined },
		{ label: "unrecognised", level: "verbose-please" },
	])("falls back to info when LOG_LEVEL is $label, rather than going silent", ({ level }) => {
		const { lines, logger } = rootFor("open-mcc-server", level)

		logger.info("a line")

		expect(lines).toHaveLength(1)
	})
})
