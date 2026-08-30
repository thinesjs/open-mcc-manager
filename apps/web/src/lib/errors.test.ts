import { ERROR_CODES } from "@open-mcc/contracts"
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

	it("explains that an in-use ssh key must have its hosts removed first", () => {
		const message = getErrorMessage({
			message: "SSH key is still in use by an enrolled host",
			data: { errorCode: "SSH_KEY_IN_USE" },
		})
		expect(message).toContain("still in use")
		expect(message).toContain("Remove the hosts using it")
	})

	it("maps each name conflict to copy naming the field the operator must change", () => {
		expect(
			getErrorMessage({ message: "conflict", data: { errorCode: "HOST_NAME_TAKEN" } }),
		).toContain("host with that name already exists")
		expect(
			getErrorMessage({ message: "conflict", data: { errorCode: "SSH_KEY_NAME_TAKEN" } }),
		).toContain("SSH key with that name already exists")
	})

	it("maps an unnamed constraint violation to copy that does not read as a server fault", () => {
		const message = getErrorMessage({
			message: "conflict",
			data: { errorCode: "CONSTRAINT_VIOLATION" },
		})
		expect(message).toContain("conflicts with data already stored")
		expect(message).not.toContain("Something went wrong")
	})

	it("renders static copy, never the server's own text, for every code the server can send", () => {
		const serverText = "presented SHA256:aaaa expected SHA256:bbbb"
		for (const errorCode of ERROR_CODES) {
			const message = getErrorMessage({ message: serverText, data: { errorCode } })
			expect(message, errorCode).not.toBe(serverText)
			expect(message, errorCode).not.toBe("Something went wrong. Please try again.")
		}
	})
})
