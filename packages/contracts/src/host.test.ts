import { describe, expect, it } from "vitest"
import { createHostInput, hostPublic } from "./host"

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

const PUBLIC_HOST = {
	id: "host-1",
	name: "vps",
	hostname: "10.0.0.1",
	port: 22,
	username: "mcc",
	mode: "system",
	status: "ready",
	hostKeyFingerprint: null,
	hostKeyAlgorithm: null,
	hostKeyTrustedAt: null,
	hostKeyTrustedByLabel: "unknown",
	osId: null,
	osName: null,
	osRelease: null,
	sandboxed: null,
	lastSeenAt: null,
	failedUnits: null,
	provisioningStep: null,
	provisioningStepIndex: null,
	provisioningStepTotal: null,
	provisioningError: null,
	teardownError: null,
	teardownRequestedAt: null,
}

describe("the timestamps a host's public view sends over the wire", () => {
	it.each(["hostKeyTrustedAt", "lastSeenAt", "teardownRequestedAt"] as const)(
		"requires %s as the ISO string the wire actually sends, not a Date object",
		(field) => {
			expect(hostPublic.safeParse({ ...PUBLIC_HOST, [field]: new Date() }).success).toBe(false)
			expect(
				hostPublic.safeParse({ ...PUBLIC_HOST, [field]: "2026-08-30T00:00:00.000Z" }).success,
			).toBe(true)
		},
	)
})
