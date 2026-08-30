import {
	FingerprintMismatchError,
	ForbiddenError,
	HostConcurrentlyModifiedError,
	HostMisconfiguredError,
	HostNotFoundError,
	HostProvisioningInProgressError,
	SshKeyNotFoundError,
} from "@open-mcc/core"
import { describe, expect, it } from "vitest"
import { mapKnownError } from "./errors"

describe("mapKnownError", () => {
	it("maps ForbiddenError to FORBIDDEN with a generic message", () => {
		expect(mapKnownError(new ForbiddenError("Forbidden: host.enroll"))).toEqual({
			code: "FORBIDDEN",
			errorCode: "FORBIDDEN",
			httpStatus: 403,
			message: "You do not have permission to perform this action",
		})
	})

	it("maps HostNotFoundError to NOT_FOUND", () => {
		expect(mapKnownError(new HostNotFoundError("Host not found: host-1"))?.code).toBe("NOT_FOUND")
	})

	it("maps SshKeyNotFoundError to NOT_FOUND", () => {
		expect(mapKnownError(new SshKeyNotFoundError("SSH key not found: key-1"))?.code).toBe(
			"NOT_FOUND",
		)
	})

	it("maps FingerprintMismatchError to BAD_REQUEST without echoing the message", () => {
		const secretFingerprint = "SHA256:abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ"
		const mapped = mapKnownError(
			new FingerprintMismatchError(`Host key fingerprint mismatch: ${secretFingerprint}`),
		)
		expect(mapped?.code).toBe("BAD_REQUEST")
		expect(mapped?.message).not.toContain(secretFingerprint)
		expect(mapped?.message).not.toContain("SHA256:")
	})

	it("maps HostMisconfiguredError to BAD_REQUEST", () => {
		expect(mapKnownError(new HostMisconfiguredError("Host misconfigured"))?.code).toBe(
			"BAD_REQUEST",
		)
	})

	it("maps HostConcurrentlyModifiedError to CONFLICT", () => {
		expect(mapKnownError(new HostConcurrentlyModifiedError("Host changed"))?.code).toBe("CONFLICT")
	})

	it("maps HostProvisioningInProgressError to CONFLICT with a distinct errorCode", () => {
		const mapped = mapKnownError(new HostProvisioningInProgressError("In progress"))
		expect(mapped?.code).toBe("CONFLICT")
		expect(mapped?.errorCode).toBe("HOST_PROVISIONING_IN_PROGRESS")
		expect(mapped?.errorCode).not.toBe(
			mapKnownError(new HostConcurrentlyModifiedError("Host changed"))?.errorCode,
		)
	})

	it("returns null for an unrecognized error, never leaking its message", () => {
		expect(mapKnownError(new Error("some internal database detail"))).toBeNull()
	})
})
