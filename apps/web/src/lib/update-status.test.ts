import { describe, expect, it } from "vitest"
import { CHECK_FAILURE_COPY, checkedAgo, checkFailureReason } from "./update-status"

const NOW = new Date("2026-09-13T12:00:00Z")

const before = (ms: number) => new Date(NOW.getTime() - ms)

describe("how long ago the last check was", () => {
	it("says just now for under a minute", () => {
		expect(checkedAgo(before(59_000), NOW)).toBe("just now")
	})

	it("counts minutes, then hours, then days", () => {
		expect(checkedAgo(before(60_000), NOW)).toBe("1 minute ago")
		expect(checkedAgo(before(59 * 60_000), NOW)).toBe("59 minutes ago")
		expect(checkedAgo(before(2 * 60 * 60_000), NOW)).toBe("2 hours ago")
		expect(checkedAgo(before(3 * 24 * 60 * 60_000), NOW)).toBe("3 days ago")
	})

	it("reads a check stamped a little in the future as just now", () => {
		expect(checkedAgo(new Date(NOW.getTime() + 5_000), NOW)).toBe("just now")
	})
})

describe("why the last check failed", () => {
	const at = () => "14:05"

	it("says until when a rate limit lasts when it is known", () => {
		expect(checkFailureReason("rate-limited", new Date(), at)).toBe(
			"GitHub is limiting requests from this network until 14:05.",
		)
	})

	it("says a rate limit without a time when none is known", () => {
		expect(checkFailureReason("rate-limited", null, at)).toBe(CHECK_FAILURE_COPY["rate-limited"])
	})

	it("uses its own words for every other failure, never anything GitHub sent", () => {
		expect(checkFailureReason("unreachable", null, at)).toBe(CHECK_FAILURE_COPY.unreachable)
		expect(checkFailureReason("not-found", new Date(), at)).toBe(CHECK_FAILURE_COPY["not-found"])
		expect(checkFailureReason("unreadable", null, at)).toBe(CHECK_FAILURE_COPY.unreadable)
	})
})
