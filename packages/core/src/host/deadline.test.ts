import { describe, expect, it } from "vitest"
import { withDeadline } from "./deadline"

describe("a host-side deadline", () => {
	it("wraps the command in timeout and keeps the outer shell, so a kill still arrives as an exit status", () => {
		expect(withDeadline(2, 10, `flock -n "$HOME/collect.lock" true`)).toBe(
			`timeout -k 2 10 flock -n "$HOME/collect.lock" true; s=$?; exit $s`,
		)
	})

	it("renders the kill grace before the deadline, as GNU timeout reads them", () => {
		expect(withDeadline(5, 50, "rm -rf -- x")).toBe("timeout -k 5 50 rm -rf -- x; s=$?; exit $s")
	})
})
