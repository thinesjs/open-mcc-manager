import { describe, expect, it } from "vitest"
import {
	ALERT_CONTROLS,
	type AlertControl,
	describeTestOutcome,
	mayUseAlertControl,
	shouldKeepPolling,
	testOutcomeOf,
} from "./alerts"

const MANAGEMENT: readonly AlertControl[] = [
	"add",
	"edit",
	"test",
	"enable",
	"rotate",
	"remove",
	"sendAgain",
	"dismiss",
]

describe("which alert controls a role may see", () => {
	it("shows an owner everything", () => {
		for (const control of ALERT_CONTROLS) {
			expect(mayUseAlertControl("owner", control)).toBe(true)
		}
	})

	it("shows an operator the list and nothing that changes a destination", () => {
		expect(mayUseAlertControl("operator", "list")).toBe(true)
		for (const control of MANAGEMENT) {
			expect(mayUseAlertControl("operator", control)).toBe(false)
		}
	})

	it("shows a viewer nothing at all, not even the list", () => {
		for (const control of ALERT_CONTROLS) {
			expect(mayUseAlertControl("viewer", control)).toBe(false)
		}
	})

	it("shows nothing while the role is still unknown", () => {
		for (const control of ALERT_CONTROLS) {
			expect(mayUseAlertControl(undefined, control)).toBe(false)
		}
	})

	it("covers every control the page renders", () => {
		expect([...ALERT_CONTROLS]).toEqual(["list", ...MANAGEMENT])
	})
})

describe("waiting for a test alert to land", () => {
	it("keeps asking while the test has not been answered yet", () => {
		expect(shouldKeepPolling({ state: undefined, reason: null, gaveUp: false })).toBe(true)
		expect(shouldKeepPolling({ state: "queued", reason: null, gaveUp: false })).toBe(true)
	})

	it("stops asking once the test arrives", () => {
		const progress = { state: "delivered", reason: null, gaveUp: false } as const

		expect(shouldKeepPolling(progress)).toBe(false)
		expect(testOutcomeOf(progress)).toEqual({ kind: "arrived" })
		expect(describeTestOutcome(testOutcomeOf(progress))).toBe("The test alert arrived.")
	})

	it("stops asking once the test fails, and says why", () => {
		const progress = { state: "failed", reason: "Server refused with 404", gaveUp: false } as const

		expect(shouldKeepPolling(progress)).toBe(false)
		expect(describeTestOutcome(testOutcomeOf(progress))).toBe(
			"The test alert did not arrive. Server refused with 404",
		)
	})

	it("stops asking once the test is given up on, with no reason to show", () => {
		const progress = { state: "abandoned", reason: null, gaveUp: false } as const

		expect(shouldKeepPolling(progress)).toBe(false)
		expect(describeTestOutcome(testOutcomeOf(progress))).toBe("The test alert did not arrive.")
	})

	it("stops asking when the page has waited long enough, without claiming it failed", () => {
		const progress = { state: "queued", reason: null, gaveUp: true } as const

		expect(shouldKeepPolling(progress)).toBe(false)
		expect(testOutcomeOf(progress)).toEqual({ kind: "still-sending" })
	})

	it("still reports a result that landed as the page gave up", () => {
		expect(testOutcomeOf({ state: "delivered", reason: null, gaveUp: true })).toEqual({
			kind: "arrived",
		})
	})
})
