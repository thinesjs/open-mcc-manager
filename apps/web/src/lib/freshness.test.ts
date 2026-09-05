import { describe, expect, it } from "vitest"
import {
	pollIntervalFor,
	SETTLED_POLL_MS,
	TRANSIENT_HOST_STATUSES,
	TRANSIENT_INSTANCE_STATUSES,
	TRANSIENT_POLL_MS,
} from "./freshness"

describe("how often to ask again", () => {
	it("asks quickly while anything is still moving", () => {
		expect(pollIntervalFor([{ status: "provisioning" }], TRANSIENT_HOST_STATUSES)).toBe(
			TRANSIENT_POLL_MS,
		)
		expect(pollIntervalFor([{ status: "needs_auth" }], TRANSIENT_INSTANCE_STATUSES)).toBe(
			TRANSIENT_POLL_MS,
		)
	})

	it("backs off once everything has settled", () => {
		expect(pollIntervalFor([{ status: "ready" }], TRANSIENT_HOST_STATUSES)).toBe(SETTLED_POLL_MS)
		expect(pollIntervalFor([{ status: "running" }], TRANSIENT_INSTANCE_STATUSES)).toBe(
			SETTLED_POLL_MS,
		)
	})

	it("still asks periodically when nothing is known yet, rather than never", () => {
		expect(pollIntervalFor(undefined, TRANSIENT_HOST_STATUSES)).toBe(SETTLED_POLL_MS)
		expect(pollIntervalFor([], TRANSIENT_HOST_STATUSES)).toBe(SETTLED_POLL_MS)
	})

	it("speeds up when only one row of many is moving", () => {
		expect(
			pollIntervalFor(
				[{ status: "ready" }, { status: "ready" }, { status: "provisioning" }],
				TRANSIENT_HOST_STATUSES,
			),
		).toBe(TRANSIENT_POLL_MS)
	})
})
