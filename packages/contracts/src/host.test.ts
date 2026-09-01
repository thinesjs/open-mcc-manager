import { describe, expect, it } from "vitest"
import { createHostInput } from "./host"

const enroll = (hostname: string) =>
	createHostInput.safeParse({
		name: "vps",
		hostname,
		sshKeyId: "key-1",
		expectedFingerprint: `SHA256:${"A".repeat(43)}`,
	})

const PUBLIC_ADDRESSES = ["vps.example.com", "203.0.113.10", "2001:db8::1"]

const TAILNET_ADDRESSES = ["vps-1", "vps-1.tail9c2f.ts.net", "100.101.102.103", "fd7a:115c:a1e0::1"]

describe("host enrolment addresses", () => {
	it("accepts hosts reachable over the public internet", () => {
		for (const hostname of PUBLIC_ADDRESSES) {
			expect(enroll(hostname).success).toBe(true)
		}
	})

	it("accepts hosts reachable only over a tailnet, which is a supported topology", () => {
		for (const hostname of TAILNET_ADDRESSES) {
			expect(enroll(hostname).success).toBe(true)
		}
	})

	it("accepts a bare MagicDNS name, which carries no dot at all", () => {
		expect(enroll("vps-1").success).toBe(true)
	})

	it("still refuses an empty address", () => {
		expect(enroll("").success).toBe(false)
	})
})
