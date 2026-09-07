import { describe, expect, it } from "vitest"
import { type EgressPolicy, egressPolicy, verifyDestinationHost } from "./egress"

const categoryOf = (raw: string, policy?: EgressPolicy) => {
	const verdict = verifyDestinationHost(raw, policy)
	return verdict.allowed ? "allowed" : verdict.category
}

describe("checking a bare server address, as an operator types it", () => {
	it("takes a public name", () => {
		expect(categoryOf("smtp.example.com")).toBe("allowed")
		expect(categoryOf("  SMTP.Example.COM  ")).toBe("allowed")
	})

	it("takes a public IPv4 literal", () => {
		expect(categoryOf("203.0.113.7")).toBe("reserved")
		expect(categoryOf("9.9.9.9")).toBe("allowed")
	})

	it("takes an IPv6 literal, bracketed or not, rather than calling it a typo", () => {
		expect(categoryOf("2606:4700:4700::1111")).toBe("allowed")
		expect(categoryOf("[2606:4700:4700::1111]")).toBe("allowed")
	})

	it("judges an IPv6 literal on the address, never on the colons in it", () => {
		for (const address of ["::1", "fe80::1", "2001:db8::1"]) {
			expect(categoryOf(address), address).not.toBe("parameters")
		}
		expect(categoryOf("::1")).toBe("loopback")
	})

	it("still refuses anything after the host, which is what the colon rule is for", () => {
		expect(categoryOf("smtp.example.com:587")).toBe("parameters")
		expect(categoryOf("smtp://smtp.example.com")).toBe("parameters")
		expect(categoryOf("smtp.example.com/submit")).toBe("parameters")
		expect(categoryOf("user@smtp.example.com")).toBe("parameters")
	})

	it("refuses a mail server on the machine OpenMCC runs on", () => {
		expect(categoryOf("localhost")).toBe("loopback")
		expect(categoryOf("127.0.0.1")).toBe("loopback")
	})

	it("refuses an empty address", () => {
		expect(categoryOf("")).toBe("unreadable")
		expect(categoryOf("   ")).toBe("unreadable")
	})

	it("honours an operator's own allowance", () => {
		const policy = egressPolicy({
			allowHttp: false,
			allowedHosts: "mail.internal",
			allowedAddresses: "192.168.4.0/24",
		})
		expect(categoryOf("192.168.4.9", policy)).toBe("allowed")
		expect(categoryOf("mail.internal", policy)).toBe("allowed")
		expect(categoryOf("192.168.5.9", policy)).toBe("private")
	})
})
