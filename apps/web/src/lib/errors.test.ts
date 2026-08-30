import { describe, expect, it } from "vitest"
import { getErrorMessage } from "./errors"

describe("getErrorMessage", () => {
	it("maps a known machine-readable error code to operator-facing copy", () => {
		const message = getErrorMessage({
			message: "Host provisioning is already in progress",
			data: { errorCode: "HOST_PROVISIONING_IN_PROGRESS" },
		})
		expect(message).toBe(
			"A provisioning attempt for this host is already in progress. Retry shortly.",
		)
	})

	it("does not read the mismatch as a generic failure", () => {
		const message = getErrorMessage({
			message: "Host key fingerprint mismatch",
			data: { errorCode: "FINGERPRINT_MISMATCH" },
		})
		expect(message).toContain("did not match the fingerprint you provided")
	})

	it("falls back to the server message for an unmapped error code", () => {
		const message = getErrorMessage({
			message: "Expected an OpenSSH SHA256 fingerprint",
			data: { errorCode: "BAD_REQUEST" },
		})
		expect(message).toBe("Expected an OpenSSH SHA256 fingerprint")
	})

	it("falls back to the server message when there is no data at all", () => {
		const message = getErrorMessage({ message: "Network request failed" })
		expect(message).toBe("Network request failed")
	})

	it("falls back to a generic message when nothing usable is present", () => {
		const message = getErrorMessage({ message: "" })
		expect(message).toBe("Something went wrong. Please try again.")
	})
})
