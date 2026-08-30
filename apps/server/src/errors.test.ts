import { isErrorCode } from "@open-mcc/contracts"
import * as core from "@open-mcc/core"
import {
	FingerprintMismatchError,
	ForbiddenError,
	HostConcurrentlyModifiedError,
	HostMisconfiguredError,
	HostNotFoundError,
	HostProvisioningInProgressError,
	SshKeyInUseError,
	SshKeyNotFoundError,
} from "@open-mcc/core"
import { DatabaseError } from "pg"
import { describe, expect, it } from "vitest"
import * as serverErrors from "./errors"
import { InvitationNotFoundError, mapKnownError } from "./errors"

type ErrorConstructor = new (message: string) => Error

const exportedErrorConstructors = <T extends object>(
	moduleExports: T,
): Array<[string, ErrorConstructor]> =>
	Object.entries(moduleExports).filter(
		(entry): entry is [string, ErrorConstructor] =>
			typeof entry[1] === "function" && entry[1].prototype instanceof Error,
	)

const databaseError = (code: string, constraint: string, detail: string): DatabaseError => {
	const error = new DatabaseError(`database said: ${detail}`, detail.length, "error")
	error.code = code
	error.constraint = constraint
	error.detail = detail
	return error
}

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

	it("maps SshKeyInUseError to CONFLICT with a distinct errorCode", () => {
		const mapped = mapKnownError(new SshKeyInUseError("SSH key key-1 is still referenced"))
		expect(mapped?.code).toBe("CONFLICT")
		expect(mapped?.errorCode).toBe("SSH_KEY_IN_USE")
	})

	it("maps InvitationNotFoundError to BAD_REQUEST without distinguishing why the invitation is unusable", () => {
		const mapped = mapKnownError(new InvitationNotFoundError("Invitation not found: inv-secret"))
		expect(mapped?.code).toBe("BAD_REQUEST")
		expect(mapped?.httpStatus).toBe(400)
		expect(mapped?.errorCode).toBe("INVITATION_NOT_FOUND")
		expect(mapped?.message).not.toContain("inv-secret")
	})

	it("returns null for an unrecognized error, never leaking its message", () => {
		expect(mapKnownError(new Error("some internal database detail"))).toBeNull()
	})
})

describe("mapKnownError on integrity constraint violations", () => {
	it("maps a duplicate host name to CONFLICT without echoing the tenant or the value", () => {
		const mapped = mapKnownError(
			databaseError(
				"23505",
				"host_org_name_unique",
				'Key ("organizationId", name)=(org-secret, vps-1) already exists.',
			),
		)
		expect(mapped?.code).toBe("CONFLICT")
		expect(mapped?.httpStatus).toBe(409)
		expect(mapped?.errorCode).toBe("HOST_NAME_TAKEN")
		expect(mapped?.message).not.toContain("org-secret")
		expect(mapped?.message).not.toContain("host_org_name_unique")
	})

	it("maps a duplicate ssh key name to CONFLICT with its own errorCode", () => {
		const mapped = mapKnownError(
			databaseError(
				"23505",
				"sshKey_org_name_unique",
				'Key ("organizationId", name)=(org-secret, deploy) already exists.',
			),
		)
		expect(mapped?.errorCode).toBe("SSH_KEY_NAME_TAKEN")
		expect(mapped?.message).not.toContain("org-secret")
	})

	it("maps an unnamed constraint violation to a generic conflict rather than an internal error", () => {
		const mapped = mapKnownError(
			databaseError(
				"23503",
				"some_future_constraint",
				"Key (id)=(org-secret) is still referenced.",
			),
		)
		expect(mapped?.code).toBe("CONFLICT")
		expect(mapped?.errorCode).toBe("CONSTRAINT_VIOLATION")
		expect(mapped?.message).not.toContain("org-secret")
		expect(mapped?.message).not.toContain("some_future_constraint")
	})

	it("leaves a not-null violation unmapped, so a server defect stays an internal error", () => {
		expect(mapKnownError(databaseError("23502", "", 'null value in column "hostname"'))).toBeNull()
	})
})

describe("mapKnownError coverage of the error classes it is given", () => {
	const wireErrorConstructors = [
		...exportedErrorConstructors(core),
		...exportedErrorConstructors(serverErrors),
	]

	it("finds error classes to check, so the coverage assertion below cannot pass vacuously", () => {
		expect(wireErrorConstructors.length).toBeGreaterThan(0)
	})

	it("maps every error class the domain packages export, so a new one cannot become a silent 500", () => {
		for (const [name, ErrorClass] of wireErrorConstructors) {
			const mapped = mapKnownError(new ErrorClass(`${name} raised for the coverage check`))
			expect(mapped, `${name} has no case in mapKnownError`).not.toBeNull()
			expect(isErrorCode(mapped?.errorCode), `${name} maps to an unknown wire error code`).toBe(
				true,
			)
		}
	})
})
