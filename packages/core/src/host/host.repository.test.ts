import { sql } from "kysely"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { seedMember, seedOrganization, teardownTestDb, testDb, trackHostId } from "../test/db"
import { isPollable } from "./health-poller"
import {
	createHostRepository,
	type HostKeyTrustUpdate,
	type HostUpdateValues,
	isProvisioningClaimStale,
	PROVISIONING_LEASE_MS,
} from "./host.repository"

const repo = createHostRepository(testDb())
let orgA = ""
let orgB = ""

const backdateProvisioningClaim = async (hostId: string, ageMs: number): Promise<void> => {
	await testDb()
		.updateTable("host")
		.set({ provisioningClaimedAt: new Date(Date.now() - ageMs) })
		.where("id", "=", hostId)
		.execute()
}

beforeAll(async () => {
	orgA = await seedOrganization("org-a")
	orgB = await seedOrganization("org-b")
})

afterAll(async () => {
	await teardownTestDb()
})

describe("isProvisioningClaimStale", () => {
	it("treats a null claim timestamp as stale, so a row reaching that state by any route stays reclaimable", () => {
		expect(isProvisioningClaimStale(null)).toBe(true)
	})

	it("treats a claim younger than the lease as not stale", () => {
		expect(isProvisioningClaimStale(new Date())).toBe(false)
	})

	it("treats a claim older than the lease as stale", () => {
		expect(isProvisioningClaimStale(new Date(Date.now() - PROVISIONING_LEASE_MS - 1_000))).toBe(
			true,
		)
	})
})

describe("host repository organization scoping", () => {
	it("returns a host to its own organization", async () => {
		const created = await repo.insert(
			{ organizationId: orgA },
			{ name: "vps-1", hostname: "10.0.0.1", port: 22, username: "mcc", sshKeyId: null },
		)
		trackHostId(created.id)
		const found = await repo.findById({ organizationId: orgA }, created.id)
		expect(found?.name).toBe("vps-1")
	})

	it("hides that host from another organization", async () => {
		const created = await repo.insert(
			{ organizationId: orgA },
			{ name: "vps-2", hostname: "10.0.0.2", port: 22, username: "mcc", sshKeyId: null },
		)
		trackHostId(created.id)
		expect(await repo.findById({ organizationId: orgB }, created.id)).toBeUndefined()
	})

	it("never lists another organization's hosts", async () => {
		const created = await repo.insert(
			{ organizationId: orgA },
			{ name: "vps-3", hostname: "10.0.0.3", port: 22, username: "mcc", sshKeyId: null },
		)
		trackHostId(created.id)
		expect(await repo.list({ organizationId: orgB })).toEqual([])
	})

	it("refuses to update across organizations", async () => {
		const created = await repo.insert(
			{ organizationId: orgA },
			{ name: "vps-4", hostname: "10.0.0.4", port: 22, username: "mcc", sshKeyId: null },
		)
		trackHostId(created.id)
		const updated = await repo.update({ organizationId: orgB }, created.id, {
			status: "ready",
		})
		expect(updated).toBeUndefined()
		const unchanged = await repo.findById({ organizationId: orgA }, created.id)
		expect(unchanged?.status).toBe("pending")
	})

	it("ignores a foreign organizationId smuggled into the patch and does not move the row", async () => {
		const created = await repo.insert(
			{ organizationId: orgA },
			{ name: "vps-6", hostname: "10.0.0.6", port: 22, username: "mcc", sshKeyId: null },
		)
		trackHostId(created.id)

		const smuggledPatch: HostUpdateValues & { organizationId: string } = {
			status: "ready",
			organizationId: orgB,
		}
		const updated = await repo.update({ organizationId: orgA }, created.id, smuggledPatch)

		expect(updated?.organizationId).toBe(orgA)
		expect(updated?.status).toBe("ready")
		const stillInOrgA = await repo.findById({ organizationId: orgA }, created.id)
		expect(stillInOrgA?.organizationId).toBe(orgA)
		expect(await repo.findById({ organizationId: orgB }, created.id)).toBeUndefined()
	})

	it("refuses to delete across organizations", async () => {
		const created = await repo.insert(
			{ organizationId: orgA },
			{ name: "vps-5", hostname: "10.0.0.5", port: 22, username: "mcc", sshKeyId: null },
		)
		trackHostId(created.id)
		const deleted = await repo.delete({ organizationId: orgB }, created.id)
		expect(deleted).toBe(false)
		const stillThere = await repo.findById({ organizationId: orgA }, created.id)
		expect(stillThere?.name).toBe("vps-5")
	})
})

describe("host repository trust attribution label", () => {
	it("rejects a partial trust tuple that sets the label without a fingerprint, algorithm, or timestamp", async () => {
		const memberId = await seedMember(orgA)
		await expect(
			repo.insert(
				{ organizationId: orgA },
				{
					name: "vps-7",
					hostname: "10.0.0.7",
					port: 22,
					username: "mcc",
					osId: "debian",
					osName: "Debian GNU/Linux 12 (bookworm)",
					failedUnits: null,
					teardownError: null,
					teardownRequestedAt: null,
					sshKeyId: null,
					hostKeyTrustedBy: memberId,
					hostKeyTrustedByLabel: "actor@example.com",
				},
			),
		).rejects.toThrow(/hostKeyTrustedBy cannot be set without/i)
	})

	it("rejects a partial trust evidence trio (fingerprint without algorithm or timestamp)", async () => {
		await expect(
			repo.insert(
				{ organizationId: orgA },
				{
					name: "vps-7c",
					hostname: "10.0.0.21",
					port: 22,
					username: "mcc",
					osId: "debian",
					osName: "Debian GNU/Linux 12 (bookworm)",
					failedUnits: null,
					teardownError: null,
					teardownRequestedAt: null,
					sshKeyId: null,
					hostKeyFingerprint: "SHA256:partial",
				},
			),
		).rejects.toThrow(
			/hostKeyFingerprint, hostKeyAlgorithm, hostKeyTrustedAt.*must be set all at once/i,
		)
	})

	it("allows a full trust evidence trio with no attributed truster, as member deletion leaves behind", async () => {
		const created = await repo.insert(
			{ organizationId: orgA },
			{
				name: "vps-7d",
				hostname: "10.0.0.22",
				port: 22,
				username: "mcc",
				osId: "debian",
				osName: "Debian GNU/Linux 12 (bookworm)",
				failedUnits: null,
				teardownError: null,
				teardownRequestedAt: null,
				sshKeyId: null,
				hostKeyFingerprint: "SHA256:orphaned",
				hostKeyAlgorithm: "ssh-ed25519",
				hostKeyTrustedAt: new Date(),
			},
		)
		trackHostId(created.id)
		expect(created.hostKeyTrustedBy).toBeNull()
		expect(created.hostKeyFingerprint).toBe("SHA256:orphaned")
	})

	it("records the caller-supplied label, not the member id, as immutable attribution", async () => {
		const memberId = await seedMember(orgA)
		const created = await repo.insert(
			{ organizationId: orgA },
			{
				name: "vps-7b",
				hostname: "10.0.0.20",
				port: 22,
				username: "mcc",
				osId: "debian",
				osName: "Debian GNU/Linux 12 (bookworm)",
				failedUnits: null,
				teardownError: null,
				teardownRequestedAt: null,
				sshKeyId: null,
				hostKeyTrustedBy: memberId,
				hostKeyTrustedByLabel: "actor@example.com",
				hostKeyFingerprint: "SHA256:cccc",
				hostKeyAlgorithm: "ssh-ed25519",
				hostKeyTrustedAt: new Date(),
			},
		)
		trackHostId(created.id)
		expect(created.hostKeyTrustedByLabel).toBe("actor@example.com")
		expect(created.hostKeyTrustedByLabel).not.toBe(memberId)
	})

	it("falls back to a placeholder label when no member trusted the host key yet", async () => {
		const created = await repo.insert(
			{ organizationId: orgA },
			{ name: "vps-8", hostname: "10.0.0.8", port: 22, username: "mcc", sshKeyId: null },
		)
		trackHostId(created.id)
		expect(created.hostKeyTrustedByLabel).toBe("unknown")
	})

	it("rejects a real truster with an empty label rather than writing a silent placeholder", async () => {
		const memberId = await seedMember(orgA)
		await expect(
			repo.insert(
				{ organizationId: orgA },
				{
					name: "vps-9",
					hostname: "10.0.0.9",
					port: 22,
					username: "mcc",
					osId: "debian",
					osName: "Debian GNU/Linux 12 (bookworm)",
					failedUnits: null,
					teardownError: null,
					teardownRequestedAt: null,
					sshKeyId: null,
					hostKeyTrustedBy: memberId,
					hostKeyTrustedByLabel: "",
					hostKeyFingerprint: "SHA256:dddd",
					hostKeyAlgorithm: "ssh-ed25519",
					hostKeyTrustedAt: new Date(),
				},
			),
		).rejects.toThrow(/hostKeyTrustedByLabel is required/i)
	})

	it("rejects a real truster with a whitespace-only label", async () => {
		const memberId = await seedMember(orgA)
		await expect(
			repo.insert(
				{ organizationId: orgA },
				{
					name: "vps-9b",
					hostname: "10.0.0.19",
					port: 22,
					username: "mcc",
					osId: "debian",
					osName: "Debian GNU/Linux 12 (bookworm)",
					failedUnits: null,
					teardownError: null,
					teardownRequestedAt: null,
					sshKeyId: null,
					hostKeyTrustedBy: memberId,
					hostKeyTrustedByLabel: "   ",
					hostKeyFingerprint: "SHA256:eeee",
					hostKeyAlgorithm: "ssh-ed25519",
					hostKeyTrustedAt: new Date(),
				},
			),
		).rejects.toThrow(/hostKeyTrustedByLabel is required/i)
	})

	it("cannot alter any trust field through the generic update", async () => {
		const memberId = await seedMember(orgA)
		const otherMemberId = await seedMember(orgA)
		const trustedAt = new Date("2024-01-01T00:00:00Z")
		const created = await repo.insert(
			{ organizationId: orgA },
			{
				name: "vps-10",
				hostname: "10.0.0.10",
				port: 22,
				username: "mcc",
				osId: "debian",
				osName: "Debian GNU/Linux 12 (bookworm)",
				failedUnits: null,
				teardownError: null,
				teardownRequestedAt: null,
				sshKeyId: null,
				hostKeyTrustedBy: memberId,
				hostKeyTrustedByLabel: "trusted@example.com",
				hostKeyFingerprint: "SHA256:original",
				hostKeyAlgorithm: "ssh-ed25519",
				hostKeyTrustedAt: trustedAt,
			},
		)
		trackHostId(created.id)

		const smuggledPatch: HostUpdateValues & {
			hostKeyTrustedBy: string
			hostKeyTrustedByLabel: string
			hostKeyFingerprint: string
			hostKeyAlgorithm: string
			hostKeyTrustedAt: Date
		} = {
			status: "ready",
			hostKeyTrustedBy: otherMemberId,
			hostKeyTrustedByLabel: "attacker@example.com",
			hostKeyFingerprint: "SHA256:forged",
			hostKeyAlgorithm: "ssh-rsa",
			hostKeyTrustedAt: new Date(),
		}
		const updated = await repo.update({ organizationId: orgA }, created.id, smuggledPatch)

		expect(updated?.status).toBe("ready")
		expect(updated?.hostKeyTrustedBy).toBe(memberId)
		expect(updated?.hostKeyTrustedByLabel).toBe("trusted@example.com")
		expect(updated?.hostKeyFingerprint).toBe("SHA256:original")
		expect(updated?.hostKeyAlgorithm).toBe("ssh-ed25519")
		expect(updated?.hostKeyTrustedAt?.toISOString()).toBe(trustedAt.toISOString())
	})
})

describe("host repository dedicated host key trust update", () => {
	it("updates the whole trust tuple atomically", async () => {
		const memberId = await seedMember(orgA)
		const created = await repo.insert(
			{ organizationId: orgA },
			{ name: "vps-11", hostname: "10.0.0.11", port: 22, username: "mcc", sshKeyId: null },
		)
		trackHostId(created.id)

		const trustedAt = new Date("2025-01-01T00:00:00Z")
		const trust: HostKeyTrustUpdate = {
			hostKeyTrustedBy: memberId,
			hostKeyTrustedByLabel: "trusted@example.com",
			hostKeyFingerprint: "SHA256:aaaa",
			hostKeyAlgorithm: "ssh-ed25519",
			hostKeyTrustedAt: trustedAt,
		}
		const updated = await repo.updateHostKeyTrust({ organizationId: orgA }, created.id, trust)

		expect(updated?.hostKeyTrustedBy).toBe(memberId)
		expect(updated?.hostKeyTrustedByLabel).toBe("trusted@example.com")
		expect(updated?.hostKeyFingerprint).toBe("SHA256:aaaa")
		expect(updated?.hostKeyAlgorithm).toBe("ssh-ed25519")
		expect(updated?.hostKeyTrustedAt?.toISOString()).toBe(trustedAt.toISOString())
	})

	it("records the new actor's label on re-trust, not the previous one", async () => {
		const firstMember = await seedMember(orgA)
		const secondMember = await seedMember(orgA)
		const created = await repo.insert(
			{ organizationId: orgA },
			{ name: "vps-12", hostname: "10.0.0.12", port: 22, username: "mcc", sshKeyId: null },
		)
		trackHostId(created.id)

		await repo.updateHostKeyTrust({ organizationId: orgA }, created.id, {
			hostKeyTrustedBy: firstMember,
			hostKeyTrustedByLabel: "first@example.com",
			hostKeyFingerprint: "SHA256:aaaa",
			hostKeyAlgorithm: "ssh-ed25519",
			hostKeyTrustedAt: new Date("2025-01-01T00:00:00Z"),
		})
		const retrusted = await repo.updateHostKeyTrust({ organizationId: orgA }, created.id, {
			hostKeyTrustedBy: secondMember,
			hostKeyTrustedByLabel: "second@example.com",
			hostKeyFingerprint: "SHA256:bbbb",
			hostKeyAlgorithm: "ssh-rsa",
			hostKeyTrustedAt: new Date("2025-02-01T00:00:00Z"),
		})

		expect(retrusted?.hostKeyTrustedBy).toBe(secondMember)
		expect(retrusted?.hostKeyTrustedByLabel).toBe("second@example.com")
		expect(retrusted?.hostKeyTrustedByLabel).not.toBe("first@example.com")
		expect(retrusted?.hostKeyFingerprint).toBe("SHA256:bbbb")
		expect(retrusted?.hostKeyAlgorithm).toBe("ssh-rsa")
	})

	it("rejects a whitespace-only label on re-trust", async () => {
		const memberId = await seedMember(orgA)
		const created = await repo.insert(
			{ organizationId: orgA },
			{ name: "vps-13", hostname: "10.0.0.13", port: 22, username: "mcc", sshKeyId: null },
		)
		trackHostId(created.id)

		await expect(
			repo.updateHostKeyTrust({ organizationId: orgA }, created.id, {
				hostKeyTrustedBy: memberId,
				hostKeyTrustedByLabel: "   ",
				hostKeyFingerprint: "SHA256:aaaa",
				hostKeyAlgorithm: "ssh-ed25519",
				hostKeyTrustedAt: new Date(),
			}),
		).rejects.toThrow(/hostKeyTrustedByLabel is required/i)
	})
})

describe("host repository provisioning claim (real Postgres)", () => {
	it("lets exactly one of two concurrent claim attempts on the same pending host succeed", async () => {
		const created = await repo.insert(
			{ organizationId: orgA },
			{ name: "vps-14", hostname: "10.0.0.14", port: 22, username: "mcc", sshKeyId: null },
		)
		trackHostId(created.id)

		const [first, second] = await Promise.all([
			repo.claimForProvisioning({ organizationId: orgA }, created.id, "pending"),
			repo.claimForProvisioning({ organizationId: orgA }, created.id, "pending"),
		])

		const claimed = [first, second].filter((row) => row !== undefined)
		expect(claimed).toHaveLength(1)
		const finalRow = await repo.findById({ organizationId: orgA }, created.id)
		expect(finalRow?.status).toBe("provisioning")
	})

	it("does not let a stale caller re-claim a host that has since become provisioning", async () => {
		const created = await repo.insert(
			{ organizationId: orgA },
			{ name: "vps-15", hostname: "10.0.0.15", port: 22, username: "mcc", sshKeyId: null },
		)
		trackHostId(created.id)
		const claimed = await repo.claimForProvisioning({ organizationId: orgA }, created.id, "pending")
		expect(claimed).toBeDefined()

		const staleReclaim = await repo.claimForProvisioning(
			{ organizationId: orgA },
			created.id,
			"pending",
		)
		expect(staleReclaim).toBeUndefined()

		const finalRow = await repo.findById({ organizationId: orgA }, created.id)
		expect(finalRow?.status).toBe("provisioning")
	})
})

describe("host repository provisioning lease expiry (real Postgres)", () => {
	it("does not let a fresh claim be reclaimed before the lease expires", async () => {
		const created = await repo.insert(
			{ organizationId: orgA },
			{ name: "vps-16", hostname: "10.0.0.16", port: 22, username: "mcc", sshKeyId: null },
		)
		trackHostId(created.id)
		const firstClaim = await repo.claimForProvisioning(
			{ organizationId: orgA },
			created.id,
			"pending",
		)
		expect(firstClaim).toBeDefined()

		const reclaim = await repo.claimForProvisioning(
			{ organizationId: orgA },
			created.id,
			"provisioning",
		)
		expect(reclaim).toBeUndefined()

		const finalRow = await repo.findById({ organizationId: orgA }, created.id)
		expect(finalRow?.provisioningAttemptId).toBe(firstClaim?.provisioningAttemptId)
	})

	it("lets an abandoned claim be reclaimed once the lease has expired", async () => {
		const created = await repo.insert(
			{ organizationId: orgA },
			{ name: "vps-17", hostname: "10.0.0.17", port: 22, username: "mcc", sshKeyId: null },
		)
		trackHostId(created.id)
		const firstClaim = await repo.claimForProvisioning(
			{ organizationId: orgA },
			created.id,
			"pending",
		)
		expect(firstClaim).toBeDefined()
		await backdateProvisioningClaim(created.id, PROVISIONING_LEASE_MS + 1_000)

		const reclaim = await repo.claimForProvisioning(
			{ organizationId: orgA },
			created.id,
			"provisioning",
		)

		expect(reclaim).toBeDefined()
		expect(reclaim?.provisioningAttemptId).not.toBe(firstClaim?.provisioningAttemptId)
		const finalRow = await repo.findById({ organizationId: orgA }, created.id)
		expect(finalRow?.status).toBe("provisioning")
		expect(finalRow?.provisioningAttemptId).toBe(reclaim?.provisioningAttemptId)
	})
})

describe("host repository provisioning finalisation (real Postgres)", () => {
	it("lets the current attempt finalise the host to ready", async () => {
		const created = await repo.insert(
			{ organizationId: orgA },
			{ name: "vps-18", hostname: "10.0.0.18", port: 22, username: "mcc", sshKeyId: null },
		)
		trackHostId(created.id)
		const claimed = await repo.claimForProvisioning({ organizationId: orgA }, created.id, "pending")
		const attemptId = claimed?.provisioningAttemptId
		if (!attemptId) throw new Error("expected a claimed attempt id")

		const finalised = await repo.finalizeProvisioning(
			{ organizationId: orgA },
			created.id,
			attemptId,
			{
				status: "ready",
				osRelease: "systemd 252 (252.22-1~deb12u1)",
			},
		)

		expect(finalised?.status).toBe("ready")
		expect(finalised?.osRelease).toBe("systemd 252 (252.22-1~deb12u1)")
		expect(finalised?.provisioningAttemptId).toBeNull()
		expect(finalised?.provisioningClaimedAt).toBeNull()
	})

	it("refuses to let a stale finaliser overwrite a newer attempt's result", async () => {
		const created = await repo.insert(
			{ organizationId: orgA },
			{ name: "vps-19", hostname: "10.0.0.23", port: 22, username: "mcc", sshKeyId: null },
		)
		trackHostId(created.id)
		const staleClaim = await repo.claimForProvisioning(
			{ organizationId: orgA },
			created.id,
			"pending",
		)
		const staleAttemptId = staleClaim?.provisioningAttemptId
		if (!staleAttemptId) throw new Error("expected a claimed attempt id")
		await backdateProvisioningClaim(created.id, PROVISIONING_LEASE_MS + 1_000)

		const freshClaim = await repo.claimForProvisioning(
			{ organizationId: orgA },
			created.id,
			"provisioning",
		)
		const freshAttemptId = freshClaim?.provisioningAttemptId
		if (!freshAttemptId) throw new Error("expected a reclaimed attempt id")
		expect(freshAttemptId).not.toBe(staleAttemptId)

		const staleFinalise = await repo.finalizeProvisioning(
			{ organizationId: orgA },
			created.id,
			staleAttemptId,
			{ status: "ready", osRelease: "systemd 252 (252.22-1~deb12u1)" },
		)
		expect(staleFinalise).toBeUndefined()

		const stillInFlight = await repo.findById({ organizationId: orgA }, created.id)
		expect(stillInFlight?.status).toBe("provisioning")
		expect(stillInFlight?.provisioningAttemptId).toBe(freshAttemptId)

		const freshFinalise = await repo.finalizeProvisioning(
			{ organizationId: orgA },
			created.id,
			freshAttemptId,
			{ status: "ready", osRelease: "systemd 252 (252.22-1~deb12u1)" },
		)
		expect(freshFinalise?.status).toBe("ready")
	})

	it("records a new attempt's progress after an earlier attempt failed", async () => {
		const scope = { organizationId: orgA }
		const created = await repo.insert(scope, {
			name: "vps-repair-progress",
			hostname: "10.0.0.124",
			port: 22,
			username: "mcc",
			sshKeyId: null,
		})
		trackHostId(created.id)
		const failed = await repo.claimForProvisioning(scope, created.id, "pending")
		const failedAttemptId = failed?.provisioningAttemptId
		if (!failedAttemptId) throw new Error("expected a claimed attempt id")
		await repo.recordProvisioningFailure(
			scope,
			created.id,
			failedAttemptId,
			"The runtime image could not be downloaded.",
			{ step: "Downloading the runtime image", index: 9, total: 15 },
		)
		await repo.finalizeProvisioning(scope, created.id, failedAttemptId, { status: "error" })

		const repair = await repo.claimForProvisioning(scope, created.id, "error")
		const repairAttemptId = repair?.provisioningAttemptId
		if (!repairAttemptId) throw new Error("expected a claimed attempt id")
		expect(repairAttemptId).not.toBe(failedAttemptId)
		await repo.recordProvisioningProgress(scope, created.id, repairAttemptId, {
			step: "Checking systemd",
			index: 0,
			total: 15,
		})

		expect(await repo.findById(scope, created.id)).toMatchObject({
			status: "provisioning",
			provisioningAttemptId: repairAttemptId,
			provisioningStep: "Checking systemd",
			provisioningStepIndex: 0,
			provisioningStepTotal: 15,
			provisioningError: null,
		})
	})
})

describe("host provisioning lease invariant (real Postgres)", () => {
	it("rejects a direct update that sets status to provisioning without lease metadata", async () => {
		const created = await repo.insert(
			{ organizationId: orgA },
			{ name: "vps-20", hostname: "10.0.0.24", port: 22, username: "mcc", sshKeyId: null },
		)
		trackHostId(created.id)

		await expect(
			testDb()
				.updateTable("host")
				.set({ status: "provisioning" })
				.where("id", "=", created.id)
				.execute(),
		).rejects.toThrow(/host_provisioning_requires_lease/)

		const unchanged = await repo.findById({ organizationId: orgA }, created.id)
		expect(unchanged?.status).toBe("pending")
	})

	it("rejects a direct update that sets status to provisioning with only one lease field", async () => {
		const created = await repo.insert(
			{ organizationId: orgA },
			{ name: "vps-21", hostname: "10.0.0.25", port: 22, username: "mcc", sshKeyId: null },
		)
		trackHostId(created.id)

		await expect(
			testDb()
				.updateTable("host")
				.set({ status: "provisioning", provisioningAttemptId: "attempt-only" })
				.where("id", "=", created.id)
				.execute(),
		).rejects.toThrow(/host_provisioning_requires_lease/)

		const unchanged = await repo.findById({ organizationId: orgA }, created.id)
		expect(unchanged?.status).toBe("pending")
	})
})

describe("host repository legacy provisioning backfill (real Postgres)", () => {
	it("gives a legacy provisioning row, as migration 0004 backfills it, a full lease before it is reclaimable", async () => {
		const created = await repo.insert(
			{ organizationId: orgA },
			{ name: "vps-22", hostname: "10.0.0.26", port: 22, username: "mcc", sshKeyId: null },
		)
		trackHostId(created.id)

		await testDb()
			.updateTable("host")
			.set({
				status: "provisioning",
				provisioningAttemptId: `backfill-${created.id}`,
				provisioningClaimedAt: new Date(),
			})
			.where("id", "=", created.id)
			.execute()

		const immediateReclaim = await repo.claimForProvisioning(
			{ organizationId: orgA },
			created.id,
			"provisioning",
		)
		expect(immediateReclaim).toBeUndefined()

		await backdateProvisioningClaim(created.id, PROVISIONING_LEASE_MS + 1_000)

		const reclaim = await repo.claimForProvisioning(
			{ organizationId: orgA },
			created.id,
			"provisioning",
		)
		expect(reclaim).toBeDefined()
	})
})

describe("host repository advisory lock scoping (real Postgres)", () => {
	it("keys the per-host lock on the organization too, so one tenant cannot stall another", async () => {
		const hostId = "advisory-lock-scoping"
		let markHeld = (): void => undefined
		const held = new Promise<void>((resolve) => {
			markHeld = resolve
		})
		let releaseHeld = (): void => undefined
		const release = new Promise<void>((resolve) => {
			releaseHeld = resolve
		})

		const holder = testDb()
			.transaction()
			.execute(async (tx) => {
				await createHostRepository(tx).lockHost({ organizationId: orgA }, hostId)
				markHeld()
				await release
			})

		try {
			await held

			const otherTenant = testDb()
				.transaction()
				.execute(async (tx) => {
					await createHostRepository(tx).lockHost({ organizationId: orgB }, hostId)
				})
			await expect(otherTenant).resolves.toBeUndefined()

			const sameTenant = testDb()
				.transaction()
				.execute(async (tx) => {
					await createHostRepository(tx).lockHost({ organizationId: orgA }, hostId)
				})
			const outcome = await Promise.race([
				sameTenant.then(() => "acquired"),
				new Promise((resolve) => setTimeout(() => resolve("blocked"), 200)),
			])
			expect(outcome).toBe("blocked")

			releaseHeld()
			await sameTenant
		} finally {
			releaseHeld()
			await holder
		}
	})
})

describe("the host table after the single host model (real Postgres)", () => {
	it("keeps no mode, no stored paths and no confinement flag", async () => {
		const { rows } = await sql<{ column_name: string }>`
			select column_name from information_schema.columns
			where table_schema = 'public' and table_name = 'host'
		`.execute(testDb())
		const columns = rows.map((row) => row.column_name)

		for (const gone of ["mode", "instancesRoot", "unitDir", "sandboxed"]) {
			expect(columns).not.toContain(gone)
		}
		expect(columns).toContain("networkStack")
	})

	it.each([null, "slirp4netns", "pasta"] as const)(
		"accepts %s as a network stack",
		async (stack) => {
			const created = await repo.insert(
				{ organizationId: orgA },
				{
					name: `stack-${stack}`,
					hostname: "10.0.0.40",
					port: 22,
					username: "mcc",
					sshKeyId: null,
				},
			)
			trackHostId(created.id)

			await testDb()
				.updateTable("host")
				.set({ networkStack: stack })
				.where("id", "=", created.id)
				.execute()

			expect((await repo.findById({ organizationId: orgA }, created.id))?.networkStack).toBe(stack)
		},
	)

	it("refuses a network stack it does not know", async () => {
		const created = await repo.insert(
			{ organizationId: orgA },
			{ name: "stack-other", hostname: "10.0.0.41", port: 22, username: "mcc", sshKeyId: null },
		)
		trackHostId(created.id)

		await expect(
			sql`update "host" set "networkStack" = 'other' where "id" = ${created.id}`.execute(testDb()),
		).rejects.toThrow(/host_network_stack_known/)
	})
})

describe("which hosts the health poller lists (real Postgres)", () => {
	it("lists a ready host only with its network stack and architecture recorded, exactly as the poller's own check allows", async () => {
		const scope = { organizationId: orgB }
		const made: string[] = []
		const wanted: string[] = []
		for (const status of ["pending", "ready", "error"] as const) {
			for (const networkStack of [null, "pasta"] as const) {
				for (const architecture of [null, "arm64"] as const) {
					const created = await repo.insert(scope, {
						name: `poll-${status}-${networkStack ?? "none"}-${architecture ?? "none"}`,
						hostname: "10.0.9.1",
						port: 22,
						username: "mcc",
						sshKeyId: null,
					})
					trackHostId(created.id)
					await testDb()
						.updateTable("host")
						.set({ status, networkStack, architecture, osRelease: "systemd 257" })
						.where("id", "=", created.id)
						.execute()
					made.push(created.id)
					if (status === "ready" && networkStack !== null && architecture !== null) {
						wanted.push(created.id)
					}
				}
			}
		}

		const listed = (await repo.listPollableAcrossOrganizations())
			.map((row) => row.id)
			.filter((id) => made.includes(id))
		const rows = await Promise.all(made.map((id) => repo.findById(scope, id)))
		const allowed = rows.flatMap((row) => (row !== undefined && isPollable(row) ? [row.id] : []))

		expect(wanted).toHaveLength(1)
		expect(listed).toEqual(wanted)
		expect(allowed).toEqual(wanted)
	})
})
