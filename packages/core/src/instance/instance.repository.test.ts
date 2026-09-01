import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
	seedMember,
	seedOrganization,
	teardownTestDb,
	testDb,
	trackHostId,
	trackInstanceConfigId,
	trackInstanceId,
} from "../test/db"
import {
	AUTH_LEASE_MS,
	createInstanceRepository,
	type InstanceUpdateValues,
	isAuthClaimStale,
} from "./instance.repository"

const repo = createInstanceRepository(testDb())
let orgA = ""
let orgB = ""
let hostA = ""

const seedHost = async (organizationId: string): Promise<string> => {
	const id = `host-${Math.random().toString(36).slice(2, 10)}`
	await testDb()
		.insertInto("host")
		.values({ id, organizationId, name: id, hostname: "10.0.0.1" })
		.execute()
	trackHostId(id)
	return id
}

const seedInstance = async (organizationId: string, hostId: string) => {
	const row = await createInstanceRepository(testDb()).insert(
		{ organizationId },
		{
			hostId,
			name: `inst-${Math.random().toString(36).slice(2, 10)}`,
			minecraftAccount: "a@b.com",
		},
	)
	trackInstanceId(row.id)
	return row
}

const backdateAuthClaim = async (id: string, ageMs: number): Promise<void> => {
	await testDb()
		.updateTable("instance")
		.set({ authClaimedAt: new Date(Date.now() - ageMs) })
		.where("id", "=", id)
		.execute()
}

beforeAll(async () => {
	orgA = await seedOrganization("inst-a")
	orgB = await seedOrganization("inst-b")
	hostA = await seedHost(orgA)
})

afterAll(async () => {
	await teardownTestDb()
})

describe("isAuthClaimStale", () => {
	it("treats a null claim timestamp as stale so a row reaching that state stays reclaimable", () => {
		expect(isAuthClaimStale(null)).toBe(true)
	})

	it("treats a claim younger than the lease as live", () => {
		expect(isAuthClaimStale(new Date())).toBe(false)
	})

	it("treats a claim older than the lease as stale", () => {
		expect(isAuthClaimStale(new Date(Date.now() - AUTH_LEASE_MS - 1_000))).toBe(true)
	})
})

describe("instance repository organization scoping", () => {
	it("refuses to read an instance belonging to another organization", async () => {
		const row = await seedInstance(orgA, hostA)
		expect(await repo.findById({ organizationId: orgB }, row.id)).toBeUndefined()
		expect(await repo.findById({ organizationId: orgA }, row.id)).toBeDefined()
	})

	it("refuses to update an instance belonging to another organization", async () => {
		const row = await seedInstance(orgA, hostA)
		expect(await repo.update({ organizationId: orgB }, row.id, { status: "error" })).toBeUndefined()
		const unchanged = await repo.findById({ organizationId: orgA }, row.id)
		expect(unchanged?.status).toBe("created")
	})

	it("cannot be made to move an instance between organizations by a smuggled patch", async () => {
		const row = await seedInstance(orgA, hostA)
		const smuggled: InstanceUpdateValues & { organizationId: string } = {
			status: "running",
			organizationId: orgB,
		}
		await repo.update({ organizationId: orgA }, row.id, smuggled)
		const after = await repo.findById({ organizationId: orgA }, row.id)
		expect(after?.organizationId).toBe(orgA)
		expect(after?.status).toBe("running")
	})

	it("refuses to delete an instance belonging to another organization", async () => {
		const row = await seedInstance(orgA, hostA)
		expect(await repo.delete({ organizationId: orgB }, row.id)).toBe(false)
		expect(await repo.findById({ organizationId: orgA }, row.id)).toBeDefined()
	})

	it("lists only the instances of the scoped organization", async () => {
		await seedInstance(orgA, hostA)
		const listed = await repo.list({ organizationId: orgB })
		expect(listed).toEqual([])
	})
})

describe("auth claim fencing", () => {
	it("lets exactly one of two concurrent claims win", async () => {
		const row = await seedInstance(orgA, hostA)
		const [first, second] = await Promise.all([
			repo.claimForAuth({ organizationId: orgA }, row.id, "attempt-1"),
			repo.claimForAuth({ organizationId: orgA }, row.id, "attempt-2"),
		])
		expect([first, second].filter((each) => each !== undefined)).toHaveLength(1)
	})

	it("lets a second actor reclaim a lease that has gone stale", async () => {
		const row = await seedInstance(orgA, hostA)
		await repo.claimForAuth({ organizationId: orgA }, row.id, "attempt-1")
		await backdateAuthClaim(row.id, AUTH_LEASE_MS + 60_000)
		const reclaimed = await repo.claimForAuth({ organizationId: orgA }, row.id, "attempt-2")
		expect(reclaimed?.authClaimId).toBe("attempt-2")
	})

	it("releases only when the attempt id matches, so a superseded attempt cannot release a live claim", async () => {
		const row = await seedInstance(orgA, hostA)
		await repo.claimForAuth({ organizationId: orgA }, row.id, "attempt-1")
		expect(await repo.releaseAuthClaim({ organizationId: orgA }, row.id, "attempt-stale")).toBe(
			false,
		)
		expect(await repo.releaseAuthClaim({ organizationId: orgA }, row.id, "attempt-1")).toBe(true)
	})
})

describe("versioned config", () => {
	it("numbers versions from one and returns the latest", async () => {
		const row = await seedInstance(orgA, hostA)
		const member = await seedMember(orgA)
		const first = await repo.insertConfigVersion(
			{ organizationId: orgA },
			row.id,
			JSON.stringify({ serverAddress: "one.example.com" }),
			{ authorId: member, authorLabel: "author@example.com" },
		)
		trackInstanceConfigId(first.id)
		const second = await repo.insertConfigVersion(
			{ organizationId: orgA },
			row.id,
			JSON.stringify({ serverAddress: "two.example.com" }),
			{ authorId: member, authorLabel: "author@example.com" },
		)
		trackInstanceConfigId(second.id)

		expect(first.version).toBe(1)
		expect(second.version).toBe(2)
		const latest = await repo.latestConfig({ organizationId: orgA }, row.id)
		expect(latest?.version).toBe(2)
	})

	it("does not return another organization's config", async () => {
		const row = await seedInstance(orgA, hostA)
		const cfg = await repo.insertConfigVersion(
			{ organizationId: orgA },
			row.id,
			JSON.stringify({ serverAddress: "one.example.com" }),
			{ authorId: null, authorLabel: "author@example.com" },
		)
		trackInstanceConfigId(cfg.id)
		expect(await repo.latestConfig({ organizationId: orgB }, row.id)).toBeUndefined()
	})
})
