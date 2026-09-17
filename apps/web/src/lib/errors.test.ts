import { AUTH_LEASE_MS, ERROR_CODES } from "@open-mcc/contracts"
import { describe, expect, it } from "vitest"
import { getErrorMessage, wasRefused } from "./errors"

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

	it("says a start waits for the sign-in that is running", () => {
		const message = getErrorMessage({
			message: "Sign-in is running for this instance",
			data: { errorCode: "INSTANCE_SIGN_IN_RUNNING" },
		})

		expect(message).toBe("Sign-in is running. Try again when it's done.")
	})

	it("★ says a sign-in never started, where the codes beside it say it is running or holding", () => {
		const notStarted = getErrorMessage({
			message: "The sign-in did not start on the host",
			data: { errorCode: "INSTANCE_SIGN_IN_DID_NOT_START" },
		})
		const running = getErrorMessage({
			message: "running",
			data: { errorCode: "INSTANCE_SIGN_IN_RUNNING" },
		})
		const holding = getErrorMessage({
			message: "held",
			data: { errorCode: "INSTANCE_AUTH_IN_PROGRESS" },
		})

		expect(notStarted).toBe("The sign-in did not start on the host. Try again in a moment.")
		expect(notStarted).not.toBe(running)
		expect(notStarted).not.toBe(holding)
		expect(notStarted).not.toMatch(/device code|is running|holding this bot/i)
	})

	it("★ says a sign-in that ran and showed no code did run, where the one that never ran did not", () => {
		const noCode = getErrorMessage({
			message: "The sign-in started but no device code appeared",
			data: { errorCode: "INSTANCE_SIGN_IN_NO_DEVICE_CODE" },
		})
		const notStarted = getErrorMessage({
			message: "The sign-in did not start on the host",
			data: { errorCode: "INSTANCE_SIGN_IN_DID_NOT_START" },
		})

		expect(noCode).toBe("The sign-in started but no device code appeared. Try again.")
		expect(noCode).not.toBe(notStarted)
		expect(noCode).not.toMatch(/did not start|in a moment/i)
		expect(notStarted).toMatch(/did not start/i)
	})

	it("★ says how long a sign-in holds the bot, counted off the lease that holds it", () => {
		const message = getErrorMessage({
			message: "This instance is being signed in to Microsoft; wait for that to finish",
			data: { errorCode: "INSTANCE_AUTH_IN_PROGRESS" },
		})

		expect(message).toBe("A sign-in is holding this bot. The hold can last 15 minutes.")
		expect(message).toContain(`${AUTH_LEASE_MS / 60_000} minutes`)
	})

	it("★ claims a sign-in is running only where the host was asked, never off a held claim", () => {
		const held = getErrorMessage({
			message: "held",
			data: { errorCode: "INSTANCE_AUTH_IN_PROGRESS" },
		})
		const running = getErrorMessage({
			message: "running",
			data: { errorCode: "INSTANCE_SIGN_IN_RUNNING" },
		})

		expect(held).not.toMatch(/being signed in|is running|wait for (that|it) to finish/i)
		expect(held).not.toBe(running)
		expect(running).toMatch(/is running/i)
	})

	it("says a removal did not finish without naming a step that may have succeeded", () => {
		const message = getErrorMessage({
			message: "The host could not finish removing this instance",
			data: { errorCode: "INSTANCE_REMOVAL_FAILED" },
		})
		expect(message).toContain("not removed")
		expect(message).not.toMatch(/files|account/i)
	})

	it("★ sends the operator to the page that holds the setting it cannot use", () => {
		const bots = getErrorMessage({
			message: "A bot setting cannot be used as it is",
			data: { errorCode: "INSTANCE_BOT_CONFIG_UNUSABLE" },
		})
		const settings = getErrorMessage({
			message: "These settings must be corrected before the bot can start",
			data: { errorCode: "INSTANCE_CONFIG_UNUSABLE" },
		})

		expect(bots).toContain("Open Bots")
		expect(bots).not.toContain("Settings")
		expect(settings).toContain("Open Settings")
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

	it("never shows a list of validation issues as if it were a sentence", () => {
		const message = getErrorMessage({
			message:
				'[ { "validation": "url", "code": "invalid_string", "message": "Invalid url", "path": [ "url" ] } ]',
			data: { errorCode: "BAD_REQUEST" },
		})
		expect(message).toBe("Something went wrong. Please try again.")
	})

	it("answers a refused drop without a hint that only fits holding an item", () => {
		expect(
			getErrorMessage({ message: "refused", data: { errorCode: "INSTANCE_LIVE_ITEM_MISSING" } }),
		).toBe("The bot does not have that item where it needs it.")
	})

	it("says the live view is not available rather than calling it a server fault", () => {
		expect(
			getErrorMessage({ message: "gone", data: { errorCode: "INSTANCE_LIVE_UNAVAILABLE" } }),
		).toBe("The bot's live view is not available right now. Try again in a moment.")
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

describe("which answers a retry could still change", () => {
	const answered = (httpStatus: number) => ({ message: "no", data: { httpStatus } })

	it.each([400, 401, 403, 404, 409, 429])(
		"★ reads %i as the server's decision about this request, which it will make again",
		(httpStatus) => {
			expect(wasRefused(answered(httpStatus))).toBe(true)
		},
	)

	it.each([500, 502, 503])("★ reads %i as a fault that may not happen twice", (httpStatus) => {
		expect(wasRefused(answered(httpStatus))).toBe(false)
	})

	it("★ reads a status that refuses nothing as no refusal, so the lower bound cannot be dropped", () => {
		expect(wasRefused(answered(200))).toBe(false)
		expect(wasRefused(answered(304))).toBe(false)
	})

	it("★ reads a request that never reached the server as no refusal", () => {
		expect(wasRefused({ message: "Failed to fetch" })).toBe(false)
		expect(wasRefused({ message: "Failed to fetch", data: null })).toBe(false)
		expect(wasRefused({ message: "no code", data: { errorCode: "FORBIDDEN" } })).toBe(false)
	})
})
