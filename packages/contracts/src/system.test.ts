import { describe, expect, it } from "vitest"
import { systemStatusSchema } from "./system"

const STATUS = {
	condition: "healthy",
	server: { version: "1.0.0", commit: "abc123", schemaVersion: "0001" },
}

describe("when the worker last reported in, as the wire sends it", () => {
	it("requires the ISO string a JSON response carries, not a Date object", () => {
		const worker = { version: "1.0.0", commit: "abc123", schemaVersion: "0001" }

		expect(
			systemStatusSchema.safeParse({ ...STATUS, worker: { ...worker, seenAt: new Date() } })
				.success,
		).toBe(false)
		expect(
			systemStatusSchema.safeParse({
				...STATUS,
				worker: { ...worker, seenAt: "2026-09-06T12:00:00.000Z" },
			}).success,
		).toBe(true)
	})

	it("still accepts no worker at all", () => {
		expect(systemStatusSchema.safeParse({ ...STATUS, worker: null }).success).toBe(true)
	})
})
