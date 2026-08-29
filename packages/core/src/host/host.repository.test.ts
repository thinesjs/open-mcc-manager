import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { seedMember, seedOrganization, teardownTestDb, testDb, trackHostId } from "../test/db"
import { createHostRepository, type HostUpdateValues } from "./host.repository"

const repo = createHostRepository(testDb())
let orgA = ""
let orgB = ""

beforeAll(async () => {
	orgA = await seedOrganization("org-a")
	orgB = await seedOrganization("org-b")
})

afterAll(async () => {
	await teardownTestDb()
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
	it("records the caller-supplied label, not the member id, as immutable attribution", async () => {
		const memberId = await seedMember(orgA)
		const created = await repo.insert(
			{ organizationId: orgA },
			{
				name: "vps-7",
				hostname: "10.0.0.7",
				port: 22,
				username: "mcc",
				sshKeyId: null,
				hostKeyTrustedBy: memberId,
				hostKeyTrustedByLabel: "actor@example.com",
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
					sshKeyId: null,
					hostKeyTrustedBy: memberId,
					hostKeyTrustedByLabel: "",
				},
			),
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
