import { isErrorCode } from "@open-mcc/contracts"
import {
	MCC_REFUSALS,
	type MccRefusal,
	McpProtocolError,
	McpRefusalError,
} from "@open-mcc/contracts/boundary/mcp"
import * as core from "@open-mcc/core"
import {
	FingerprintMismatchError,
	ForbiddenError,
	HostConcurrentlyModifiedError,
	HostMisconfiguredError,
	HostNotFoundError,
	HostProvisioningInProgressError,
	InstanceRemovalFailedError,
	InstanceSignInDidNotStartError,
	InstanceSignInNoDeviceCodeError,
	InstanceSignInRunningError,
	SshKeyInUseError,
	SshKeyNotFoundError,
} from "@open-mcc/core"
import * as transport from "@open-mcc/transport"
import { LiveChannelUnavailableError } from "@open-mcc/transport"
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

	it("maps InstanceSignInRunningError to CONFLICT, under its own code", () => {
		expect(
			mapKnownError(new InstanceSignInRunningError("Sign-in is running for instance abc123")),
		).toMatchObject({ code: "CONFLICT", errorCode: "INSTANCE_SIGN_IN_RUNNING" })
	})

	it("★ answers a sign-in that never started under its own code, in words the host did not write", () => {
		const mapped = mapKnownError(
			new InstanceSignInDidNotStartError(
				[
					"The sign-in unit for instance abc123 did not start: Job for open-mcc-auth@abc123.service failed because a timeout was exceeded.",
					'See "journalctl --user -xeu open-mcc-auth@abc123.service" for details.',
				].join("\n"),
			),
		)

		expect(mapped).toEqual({
			code: "BAD_REQUEST",
			errorCode: "INSTANCE_SIGN_IN_DID_NOT_START",
			httpStatus: 400,
			message: "The sign-in did not start on the host",
		})
		expect(mapped?.message).not.toMatch(/journalctl|systemctl|open-mcc-auth|abc123/)
	})

	it("★ answers a sign-in that started and produced no code as its own failure, never as a 500", () => {
		const mapped = mapKnownError(
			new InstanceSignInNoDeviceCodeError(
				"The client did not present a device code for instance abc123 within the polling window",
			),
		)

		expect(mapped).toEqual({
			code: "BAD_REQUEST",
			errorCode: "INSTANCE_SIGN_IN_NO_DEVICE_CODE",
			httpStatus: 400,
			message: "The sign-in started but no device code appeared",
		})
	})

	it("★ answers a host that refused the start apart from a host that ran it and said nothing", () => {
		const refused = mapKnownError(new InstanceSignInDidNotStartError("did not start"))
		const quiet = mapKnownError(new InstanceSignInNoDeviceCodeError("no code"))

		expect(refused?.errorCode).not.toBe(quiet?.errorCode)
		expect(refused?.message).not.toBe(quiet?.message)
	})

	it("★ calls a host command the manager watched fail a bad request, as removal and provisioning do", () => {
		const watched = [
			mapKnownError(new InstanceSignInDidNotStartError("the start exec resolved non-zero")),
			mapKnownError(new InstanceSignInNoDeviceCodeError("every poll resolved empty")),
			mapKnownError(new InstanceRemovalFailedError("a removal step resolved non-zero")),
		]

		for (const mapped of watched) {
			expect(mapped?.code).toBe("BAD_REQUEST")
			expect(mapped?.httpStatus).toBe(400)
		}
		expect(mapKnownError(new transport.CommandTimedOutError("no answer"))?.code).toBe("CONFLICT")
		expect(mapKnownError(new InstanceSignInRunningError("held"))?.code).toBe("CONFLICT")
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

	it("never reports a refusal the client sent on purpose as a reply it could not read", () => {
		for (const refusal of MCC_REFUSALS) {
			const mapped = mapKnownError(new McpRefusalError(refusal))
			expect(mapped, refusal).not.toBeNull()
			expect(mapped?.errorCode, refusal).not.toBe("INSTANCE_LIVE_CONTROL_UNREADABLE")
		}
	})

	it("gives each kind of refusal its own code, so the dashboard can say what happened", () => {
		const codeFor = (refusal: MccRefusal) => mapKnownError(new McpRefusalError(refusal))?.errorCode

		expect(codeFor("capability_disabled")).toBe("INSTANCE_LIVE_TURNED_OFF")
		expect(codeFor("feature_disabled")).toBe("INSTANCE_LIVE_TURNED_OFF")
		expect(codeFor("disconnected")).toBe("INSTANCE_LIVE_NOT_JOINED")
		expect(codeFor("invalid_args")).toBe("INSTANCE_LIVE_UNKNOWN_ITEM")
		expect(codeFor("invalid_state")).toBe("INSTANCE_LIVE_ITEM_MISSING")
		expect(codeFor("action_failed")).toBe("INSTANCE_LIVE_ACTION_FAILED")
	})

	it("treats a refused item as a conflict with the bot's state, not a server fault", () => {
		expect(mapKnownError(new McpRefusalError("invalid_state"))).toMatchObject({
			code: "CONFLICT",
			httpStatus: 409,
		})
	})

	it("still reports a reply it truly could not read as unreadable", () => {
		expect(mapKnownError(new McpProtocolError("malformed"))?.errorCode).toBe(
			"INSTANCE_LIVE_CONTROL_UNREADABLE",
		)
	})

	it("maps McpProtocolError to CONFLICT without echoing the address the client named", () => {
		const address = "10.42.0.7:33333"
		const mapped = mapKnownError(new McpProtocolError(`connect ${address} refused`))

		expect(mapped?.code).toBe("CONFLICT")
		expect(mapped?.errorCode).toBe("INSTANCE_LIVE_CONTROL_UNREADABLE")
		expect(mapped?.message).not.toContain(address)
		expect(mapped?.message).not.toContain("10.42.0.7")
		expect(mapped?.message).not.toContain("33333")
	})

	it("maps McpProtocolError to CONFLICT without echoing a credential the client named", () => {
		const credential = "MCC_MCP_AUTH_TOKEN=s3cr3t-value"
		const mapped = mapKnownError(new McpProtocolError(`rejected ${credential}`))

		expect(mapped?.code).toBe("CONFLICT")
		expect(mapped?.message).not.toContain(credential)
		expect(mapped?.message).not.toContain("s3cr3t-value")
	})

	it("gives every unreadable client answer the same words, so no readout can leak through its own", () => {
		const messages = [
			"player stats broke at 10.42.0.7",
			"status effects broke at 10.42.0.7",
			"loaded bots broke at 10.42.0.7",
			"players list broke at 10.42.0.7",
		]

		const mapped = messages.map((message) => mapKnownError(new McpProtocolError(message))?.message)

		expect(new Set(mapped).size).toBe(1)
		expect(mapped[0]).toBe("The client answered in a way this manager could not read")
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

	it("says a removal did not finish without naming a step that may have succeeded", () => {
		const mapped = mapKnownError(new InstanceRemovalFailedError("Instance abc123 did not finish"))

		expect(mapped?.errorCode).toBe("INSTANCE_REMOVAL_FAILED")
		expect(mapped?.message).toContain("not removed")
		expect(mapped?.message).not.toMatch(/files|account/i)
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

	it("maps a duplicate config version to the conflict the forms already explain", () => {
		const mapped = mapKnownError(
			databaseError(
				"23505",
				"instanceConfig_instance_version_unique",
				'Key ("instanceId", version)=(abc123, 2) already exists.',
			),
		)
		expect(mapped?.code).toBe("CONFLICT")
		expect(mapped?.errorCode).toBe("INSTANCE_CONCURRENTLY_MODIFIED")
		expect(mapped?.message).not.toContain("abc123")
		expect(mapped?.message).not.toContain("instanceConfig_instance_version_unique")
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
		...exportedErrorConstructors(transport),
	]

	it("finds error classes to check, so the coverage assertion below cannot pass vacuously", () => {
		expect(wireErrorConstructors.length).toBeGreaterThan(0)
	})

	it("answers a drop or hold with no live channel as a conflict the dashboard can explain", () => {
		expect(
			mapKnownError(new LiveChannelUnavailableError("Live view is not open for this instance")),
		).toMatchObject({ code: "CONFLICT", errorCode: "INSTANCE_LIVE_UNAVAILABLE", httpStatus: 409 })
	})

	it("answers a command the host cut off as a conflict, in words that name no command", () => {
		const interrupted = {
			code: "CONFLICT",
			errorCode: "HOST_COMMAND_INTERRUPTED",
			httpStatus: 409,
			message: "A command on the host stopped before it finished",
		}

		expect(
			mapKnownError(new transport.CommandAbortedError("systemctl start 'unit'", "SIGKILL")),
		).toMatchObject(interrupted)
		expect(
			mapKnownError(new transport.StreamOverflowError("stdout", 1024, "tail of the output")),
		).toMatchObject(interrupted)
	})

	it("answers a host that stopped answering in one set of words, whichever way it stopped", () => {
		const notAnswering = {
			code: "CONFLICT",
			errorCode: "HOST_NOT_ANSWERING",
			httpStatus: 409,
			message: "The host did not answer in time",
		}

		for (const interrupted of [
			new transport.ChannelQueueExpiredError("queued too long for 10.42.0.7"),
			new transport.ReadDeadlineExceededError("deadline passed on 10.42.0.7:22"),
			new transport.ReadConnectionLostError("Not connected"),
			new transport.CommandTimedOutError("Command timed out: cat /etc/secret"),
			new transport.ChannelOpenTimedOutError("Command timed out waiting for a channel: ls"),
		]) {
			expect(mapKnownError(interrupted)).toEqual(notAnswering)
		}
	})

	it("still calls a forward that timed out an unavailable live channel", () => {
		expect(mapKnownError(new transport.ForwardTimedOutError("port 33333"))?.errorCode).toBe(
			"INSTANCE_LIVE_UNAVAILABLE",
		)
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
