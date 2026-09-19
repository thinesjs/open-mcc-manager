import { describe, expect, it } from "vitest"
import { interpretExitCode, shouldRestartOn } from "./exit-code"

describe("mcc exit codes", () => {
	it("maps the codes observed from build 511, run against a fifo as systemd runs it", () => {
		expect(interpretExitCode(0)).toBe("clean")
		expect(interpretExitCode(2)).toBe("kicked")
		expect(interpretExitCode(3)).toBe("connection_lost")
		expect(interpretExitCode(4)).toBe("login_failed")
		expect(interpretExitCode(1)).toBe("unknown")
		expect(interpretExitCode(137)).toBe("unknown")
	})

	it("treats an unrecognised code as restartable, so a wrong guess fails safe", () => {
		for (const code of [2, 5, 6, 137]) {
			expect(shouldRestartOn(interpretExitCode(code))).toBe(true)
		}
	})

	it("never restarts a failed login, which is what hammering microsoft auth would be", () => {
		expect(shouldRestartOn("login_failed")).toBe(false)
		expect(shouldRestartOn("clean")).toBe(false)
		expect(shouldRestartOn("kicked")).toBe(true)
		expect(shouldRestartOn("connection_lost")).toBe(true)
		expect(shouldRestartOn("unknown")).toBe(true)
	})
})
