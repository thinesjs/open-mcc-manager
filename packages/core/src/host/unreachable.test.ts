import { describe, expect, it } from "vitest"
import { COULD_NOT_CONNECT, connectFailureReason } from "./unreachable"

const withField = (message: string, field: "code" | "level", value: string): Error =>
	Object.assign(new Error(message), { [field]: value })

describe("why a host could not be reached, in words that name no address", () => {
	it("tells a refused connection apart from one that never answered", () => {
		expect(
			connectFailureReason(
				withField("connect ECONNREFUSED 203.0.113.9:2222", "code", "ECONNREFUSED"),
			),
		).toBe("The server refused the connection")
		expect(
			connectFailureReason(withField("connect ETIMEDOUT 203.0.113.9:2222", "code", "ETIMEDOUT")),
		).toBe("The server did not answer in time")
	})

	it("says an address could not be found or reached", () => {
		expect(
			connectFailureReason(withField("getaddrinfo ENOTFOUND vps.example.net", "code", "ENOTFOUND")),
		).toBe("That address could not be found")
		expect(
			connectFailureReason(
				withField("connect EHOSTUNREACH 203.0.113.9:2222", "code", "EHOSTUNREACH"),
			),
		).toBe("That address could not be reached")
		expect(
			connectFailureReason(
				withField("Error while looking up IPv4 address for 'vps': x", "level", "client-dns"),
			),
		).toBe("That address could not be found")
	})

	it("says the server dropped the connection", () => {
		expect(connectFailureReason(withField("read ECONNRESET", "code", "ECONNRESET"))).toBe(
			"The server closed the connection",
		)
	})

	it("says the server did not accept the key", () => {
		expect(
			connectFailureReason(
				withField("All configured authentication methods failed", "level", "client-authentication"),
			),
		).toBe("The server did not accept this SSH key")
	})

	it("says the server's key did not match", () => {
		expect(connectFailureReason(new Error("Host denied (verification failed)"))).toBe(
			"The server's key did not match the fingerprint",
		)
	})

	it("reads every timeout this side raises as a timeout", () => {
		for (const message of [
			"Connection to vps.example.net timed out",
			"Timed out reading host key from 203.0.113.9:2222",
		]) {
			expect(connectFailureReason(new Error(message)), message).toBe(
				"The server did not answer in time",
			)
		}
		expect(
			connectFailureReason(
				withField("Timed out while waiting for handshake", "level", "client-timeout"),
			),
		).toBe("The server did not answer in time")
	})

	it("falls back to a plain sentence for anything else, never the error's own words", () => {
		expect(connectFailureReason(new Error("No host key offered by 203.0.113.9:2222"))).toBe(
			COULD_NOT_CONNECT,
		)
	})
})
