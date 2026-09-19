import { describe, expect, it } from "vitest"
import { encodeStatusEventCursor, parseStatusEventCursor } from "./status-cursor"

describe("the status event cursor", () => {
	it("carries both halves of the ordering back unchanged", () => {
		const cursor = { occurredAt: new Date("2026-09-13T10:07:30.125Z"), id: "event-42" }
		const parsed = parseStatusEventCursor(encodeStatusEventCursor(cursor))

		expect(parsed?.occurredAt.toISOString()).toBe("2026-09-13T10:07:30.125Z")
		expect(parsed?.id).toBe("event-42")
	})

	it("refuses a string that is not a cursor", () => {
		for (const raw of [
			"",
			"event-42",
			"|event-42",
			"2026-09-13T10:07:30.125Z|",
			"not-a-date|event-42",
			"2026-09-13|event-42",
			"5|event-42",
		]) {
			expect(parseStatusEventCursor(raw)).toBeUndefined()
		}
	})

	it("keeps an id that is longer than one segment whole", () => {
		expect(parseStatusEventCursor("2026-09-13T10:07:30.000Z|a|b")?.id).toBe("a|b")
	})
})
