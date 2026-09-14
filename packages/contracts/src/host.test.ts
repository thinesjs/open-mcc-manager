import { describe, expect, it } from "vitest"
import { createHostInput, hostPublic } from "./host"
import { HOST_CHECK_NAMES, hostCheckResult } from "./host-check"

const HOST = {
	name: "vps",
	sshKeyId: "key-1",
	username: "mcc",
	expectedFingerprint: `SHA256:${"A".repeat(43)}`,
}

const enroll = (hostname: string) => createHostInput.safeParse({ ...HOST, hostname })

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

describe("the one host model", () => {
	it("refuses a host with no account, rather than assuming root", () => {
		const { username: _omitted, ...withoutAccount } = HOST

		expect(createHostInput.safeParse({ ...withoutAccount, hostname: "vps-1" }).success).toBe(false)
	})

	it("takes no mode, and drops one sent anyway", () => {
		const parsed = createHostInput.safeParse({ ...HOST, hostname: "vps-1", mode: "system" })

		expect(Object.keys(createHostInput.shape)).not.toContain("mode")
		expect(parsed.success ? Object.keys(parsed.data) : ["unparsed"]).not.toContain("mode")
		expect(parsed.success).toBe(true)
	})

	it("describes a host with no mode and no confinement flag", () => {
		expect(Object.keys(hostPublic.shape)).not.toContain("mode")
		expect(Object.keys(hostPublic.shape)).not.toContain("sandboxed")
	})
})

const PUBLIC_HOST = {
	id: "host-1",
	name: "vps",
	hostname: "10.0.0.1",
	port: 22,
	username: "mcc",
	status: "ready",
	hostKeyFingerprint: null,
	hostKeyAlgorithm: null,
	hostKeyTrustedAt: null,
	hostKeyTrustedByLabel: "unknown",
	osId: null,
	osName: null,
	osRelease: null,
	lastSeenAt: null,
	failedUnits: null,
	provisioningStep: null,
	provisioningStepIndex: null,
	provisioningStepTotal: null,
	provisioningError: null,
	teardownError: null,
	teardownRequestedAt: null,
}

describe("what a host check reports", () => {
	const RESULT = { name: "podman", outcome: "fail", detail: "Podman isn't installed." }

	it("names every prerequisite the Podman runtime needs, in the order the check shows them", () => {
		expect(HOST_CHECK_NAMES).toEqual([
			"reachable",
			"account",
			"systemd",
			"architecture",
			"lingering",
			"podman",
			"cgroups",
			"subordinate-ids",
			"network-helper",
			"storage",
			"tcp-forwarding",
			"cloud-metadata",
			"client-runtime",
		])
	})

	it("carries the command that fixes a result, or null when no command does", () => {
		const command = "sudo loginctl enable-linger mcc"

		expect(hostCheckResult.parse({ ...RESULT, command, hint: null }).command).toBe(command)
		expect(hostCheckResult.parse({ ...RESULT, command: null, hint: null }).command).toBeNull()
		expect(hostCheckResult.safeParse({ ...RESULT, hint: null }).success).toBe(false)
	})

	it("carries the detail a tooltip shows, or null when there is none", () => {
		const hint = "Podman needs cgroup v2."

		expect(hostCheckResult.parse({ ...RESULT, command: null, hint }).hint).toBe(hint)
		expect(hostCheckResult.safeParse({ ...RESULT, command: null }).success).toBe(false)
	})

	it("refuses a name that is no longer checked", () => {
		expect(
			hostCheckResult.safeParse({ ...RESULT, name: "confinement", command: null, hint: null })
				.success,
		).toBe(false)
	})
})

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
