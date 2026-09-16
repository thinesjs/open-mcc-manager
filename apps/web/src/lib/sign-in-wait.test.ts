import { describe, expect, it } from "vitest"
import {
	describeSignInWaitWindow,
	endSignInWait,
	noteSignInNotYet,
	SIGN_IN_CHECK_INTERVAL_MS,
	SIGN_IN_WAIT_WINDOW_MS,
	signInWaitFor,
} from "./sign-in-wait"

describe("how long the page waits for a sign-in to land", () => {
	it("leaves room for several checks without hammering the host", () => {
		const checks = SIGN_IN_WAIT_WINDOW_MS / SIGN_IN_CHECK_INTERVAL_MS

		expect(checks).toBeGreaterThanOrEqual(8)
		expect(checks).toBeLessThanOrEqual(30)
	})

	it("waits long enough to be worth waiting and stops well inside a code's life", () => {
		expect(SIGN_IN_CHECK_INTERVAL_MS).toBeGreaterThanOrEqual(3_000)
		expect(SIGN_IN_WAIT_WINDOW_MS).toBeGreaterThanOrEqual(60_000)
		expect(SIGN_IN_WAIT_WINDOW_MS).toBeLessThanOrEqual(5 * 60_000)
	})

	it("says the window in the same words the constant is set in", () => {
		expect(describeSignInWaitWindow()).toBe(`${SIGN_IN_WAIT_WINDOW_MS / 60_000} minutes`)
	})
})

describe("whose wait it is", () => {
	it("★ hands back nothing for a bot the wait does not belong to", () => {
		const wait = noteSignInNotYet(undefined, "bot-1", 1_000)

		expect(signInWaitFor(wait, "bot-1")).toBe(wait)
		expect(signInWaitFor(wait, "bot-2")).toBeUndefined()
		expect(signInWaitFor(undefined, "bot-1")).toBeUndefined()
	})

	it("★ starts a fresh window rather than adopting another bot's", () => {
		const first = noteSignInNotYet(undefined, "bot-1", 1_000)

		const second = noteSignInNotYet(first, "bot-2", 50_000)

		expect(second.instanceId).toBe("bot-2")
		expect(second.until).toBe(50_000 + SIGN_IN_WAIT_WINDOW_MS)
		expect(second.checks).toBe(1)
	})
})

describe("a check that answers not yet", () => {
	it("opens a window one window long from now", () => {
		expect(noteSignInNotYet(undefined, "bot-1", 1_000)).toEqual({
			instanceId: "bot-1",
			until: 1_000 + SIGN_IN_WAIT_WINDOW_MS,
			checks: 1,
			ended: false,
		})
	})

	it("★ counts the check without moving the deadline, so nothing can extend the window", () => {
		const first = noteSignInNotYet(undefined, "bot-1", 1_000)

		const second = noteSignInNotYet(first, "bot-1", 1_000 + SIGN_IN_WAIT_WINDOW_MS / 2)

		expect(second.until).toBe(first.until)
		expect(second.checks).toBe(first.checks + 1)
	})

	it("★ opens a fresh window once the last one ended, so a press after the end does something", () => {
		const ended = endSignInWait(noteSignInNotYet(undefined, "bot-1", 1_000))

		const after = noteSignInNotYet(ended, "bot-1", 500_000)

		expect(after.ended).toBe(false)
		expect(after.until).toBe(500_000 + SIGN_IN_WAIT_WINDOW_MS)
		expect(after.checks).toBe(1)
	})
})

describe("ending the wait", () => {
	it("marks the window ended without moving its deadline", () => {
		const open = noteSignInNotYet(undefined, "bot-1", 1_000)

		expect(endSignInWait(open)).toEqual({
			instanceId: "bot-1",
			until: open.until,
			checks: open.checks,
			ended: true,
		})
	})

	it("has nothing to end when no wait was running", () => {
		expect(endSignInWait(undefined)).toBeUndefined()
	})
})
