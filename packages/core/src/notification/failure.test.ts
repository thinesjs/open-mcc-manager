import { describe, expect, it } from "vitest"
import { DID_NOT_GO_THROUGH, networkReason } from "./failure"

const withCode = (code: string, message: string): Error =>
	Object.assign(new Error(message), { code })

describe("what an operator is told when a delivery never got there", () => {
	it("never repeats the address the library put in its message", () => {
		const leaky = withCode(
			"UND_ERR_CONNECT_TIMEOUT",
			"Connect Timeout Error (attempted address: 192.168.88.62:8899, timeout: 20000ms)",
		)
		const reason = networkReason(leaky)

		expect(reason).toBe("That address did not answer in time")
		expect(reason).not.toContain("192.168.88.62")
		expect(reason).not.toContain("8899")
		expect(reason).not.toContain("Connect Timeout Error")
	})

	it("says something different for each kind of failure an operator can act on", () => {
		expect(networkReason(withCode("ECONNREFUSED", "connect ECONNREFUSED 10.0.0.1:587"))).toBe(
			"That address refused the connection",
		)
		expect(networkReason(withCode("ECONNRESET", "socket hang up"))).toBe(
			"That address closed the connection",
		)
		expect(networkReason(withCode("EHOSTUNREACH", "connect EHOSTUNREACH 10.0.0.1"))).toBe(
			"That address could not be reached",
		)
		expect(networkReason(withCode("ENOTFOUND", "getaddrinfo ENOTFOUND mail.example.com"))).toBe(
			"That address could not be reached",
		)
	})

	it("names a certificate problem as one, whichever code the runtime used", () => {
		for (const code of [
			"ERR_TLS_CERT_ALTNAME_INVALID",
			"CERT_HAS_EXPIRED",
			"DEPTH_ZERO_SELF_SIGNED_CERT",
		]) {
			expect(networkReason(withCode(code, "some raw tls detail")), code).toBe(
				"That address presented a certificate we could not trust",
			)
		}
	})

	it("looks under the wrapper undici puts around the real error", () => {
		const wrapped = Object.assign(new Error("other side closed"), {
			code: "UND_ERR_SOCKET",
			cause: Object.assign(new Error("connect ECONNREFUSED 10.0.0.1:587"), {
				code: "ECONNREFUSED",
			}),
		})
		expect(networkReason(wrapped)).toBe("That address closed the connection")

		const onlyInCause = Object.assign(new Error("fetch failed"), {
			cause: Object.assign(new Error("certificate has expired"), { code: "CERT_HAS_EXPIRED" }),
		})
		expect(networkReason(onlyInCause)).toBe(
			"That address presented a certificate we could not trust",
		)
	})

	it("names every member of the certificate family, not just the one code", () => {
		for (const code of [
			"CERT_HAS_EXPIRED",
			"CERT_NOT_YET_VALID",
			"UNABLE_TO_VERIFY_LEAF_SIGNATURE",
			"UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
			"SELF_SIGNED_CERT_IN_CHAIN",
			"DEPTH_ZERO_SELF_SIGNED_CERT",
			"ERR_TLS_CERT_ALTNAME_INVALID",
			"ERR_SSL_WRONG_VERSION_NUMBER",
			"HOSTNAME_MISMATCH",
		]) {
			expect(networkReason(withCode(code, "raw tls detail")), code).toBe(
				"That address presented a certificate we could not trust",
			)
		}
	})

	it("treats an abandoned attempt as a timeout", () => {
		expect(networkReason(Object.assign(new Error("aborted"), { name: "AbortError" }))).toBe(
			"That address did not answer in time",
		)
	})

	it("falls back to one plain sentence rather than the library's words", () => {
		expect(networkReason(new Error("Some internal detail nobody should read"))).toBe(
			DID_NOT_GO_THROUGH,
		)
		expect(networkReason(withCode("E_SOMETHING_NEW", "future error text"))).toBe(DID_NOT_GO_THROUGH)
		expect(networkReason(undefined)).toBe(DID_NOT_GO_THROUGH)
	})

	it("never returns anything that looks like an address or a port", () => {
		const samples: Error[] = [
			withCode(
				"UND_ERR_CONNECT_TIMEOUT",
				"Connect Timeout Error (attempted address: 203.0.113.7:25)",
			),
			withCode("ECONNREFUSED", "connect ECONNREFUSED 127.0.0.1:2525"),
			new Error("read ECONNRESET from smtp.internal:465"),
		]
		for (const error of samples) {
			expect(networkReason(error)).not.toMatch(/\d+\.\d+\.\d+\.\d+|:\d{2,5}\b/)
		}
	})
})
