import type { SshHandshake } from "@open-mcc/transport"
import { describe, expect, it } from "vitest"
import { ADDRESS_PROBE_TIMEOUT_MS, addressProbeOutcomeFor } from "./address-probe"
import { CONNECT_TIMEOUT_MS } from "./host.controller"

const failedWith = (
	properties: Record<string, string>,
	message = "connect failed",
): SshHandshake => ({
	kind: "failed",
	error: Object.assign(new Error(message), properties),
})

describe("what an address probe tells the operator", () => {
	it("says the address answered only when a host key was offered", () => {
		expect(addressProbeOutcomeFor({ kind: "key", key: Buffer.from("key") })).toBe("answered")
	})

	it.each(["ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH", "ENETDOWN"])(
		"says nothing answered on %s",
		(code) => {
			expect(addressProbeOutcomeFor(failedWith({ code }))).toBe("no-answer")
		},
	)

	it("says nothing answered when the name does not resolve", () => {
		expect(addressProbeOutcomeFor(failedWith({ level: "client-dns" }))).toBe("no-answer")
	})

	it("says refused when the port turns the connection away", () => {
		expect(addressProbeOutcomeFor(failedWith({ code: "ECONNREFUSED" }))).toBe("refused")
	})

	it.each([
		{ shape: "a socket timeout", handshake: failedWith({ code: "ETIMEDOUT" }) },
		{ shape: "a handshake timeout", handshake: failedWith({ level: "client-timeout" }) },
		{ shape: "our own deadline", handshake: { kind: "timed-out" } satisfies SshHandshake },
	])("says timed out on $shape", ({ handshake }) => {
		expect(addressProbeOutcomeFor(handshake)).toBe("timed-out")
	})

	it.each([
		"Invalid identification string",
		"Header line too long",
		"Max greeting lines exceeded",
		"Invalid header: expected newline",
	])("says it is not SSH only on what the peer actually sent: %s", (message) => {
		expect(addressProbeOutcomeFor(failedWith({}, message))).toBe("not-ssh")
	})

	it.each([
		{
			shape: "a connection closed with no key and no error",
			handshake: { kind: "closed" } as const,
		},
		{ shape: "a reset", handshake: failedWith({ code: "ECONNRESET" }) },
		{ shape: "a broken pipe", handshake: failedWith({ code: "EPIPE" }) },
		{ shape: "anything it does not recognise", handshake: failedWith({}, "Unable to parse") },
	])("admits it could not tell on $shape, rather than blaming the port", ({ handshake }) => {
		expect(addressProbeOutcomeFor(handshake)).toBe("unclear")
	})

	it("waits less than the connect the rest of enrolment makes, since it only asks one question", () => {
		expect(ADDRESS_PROBE_TIMEOUT_MS).toBeLessThan(CONNECT_TIMEOUT_MS)
	})
})
