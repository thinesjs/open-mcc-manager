import { describe, expect, it } from "vitest"
import { interpretExitCode, shouldRestartOn } from "./exit-code"

describe("mcc exit codes", () => {
	it("maps every code the client can return", () => {
		expect(interpretExitCode(0)).toBe("clean")
		expect(interpretExitCode(2)).toBe("kicked")
		expect(interpretExitCode(3)).toBe("connection_lost")
		expect(interpretExitCode(4)).toBe("login_rejected")
		expect(interpretExitCode(1)).toBe("unknown")
		expect(interpretExitCode(137)).toBe("unknown")
	})

	it("never restarts a rejected login, which is what hammering microsoft auth would be", () => {
		expect(shouldRestartOn("login_rejected")).toBe(false)
		expect(shouldRestartOn("clean")).toBe(false)
		expect(shouldRestartOn("kicked")).toBe(true)
		expect(shouldRestartOn("connection_lost")).toBe(true)
		expect(shouldRestartOn("unknown")).toBe(true)
	})
})
