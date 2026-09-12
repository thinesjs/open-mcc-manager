import type { INSTANCE_ARTIFACT_KINDS } from "@open-mcc/contracts"
import type { InstanceArtifactKind } from "@open-mcc/db"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { seedOrganization, teardownTestDb, testDb, trackHostId, trackInstanceId } from "../test/db"
import { createArtifactRepository } from "./artifact.repository"

const repo = createArtifactRepository(testDb())

let ownerOrg = ""
let otherOrg = ""
let ownerInstance = ""
let otherInstance = ""

type RefinementOf<Narrowed extends Base, Base> = Narrowed

type _DatabaseKindsMatchTheContract = RefinementOf<
	InstanceArtifactKind,
	(typeof INSTANCE_ARTIFACT_KINDS)[number]
>

type _ContractKindsMatchTheDatabase = RefinementOf<
	(typeof INSTANCE_ARTIFACT_KINDS)[number],
	InstanceArtifactKind
>

const seedInstance = async (organizationId: string, port: number): Promise<string> => {
	const hostId = `host-${Math.random().toString(36).slice(2, 10)}`
	await testDb()
		.insertInto("host")
		.values({ id: hostId, organizationId, name: hostId, hostname: "10.0.0.1" })
		.execute()
	trackHostId(hostId)
	const row = await testDb()
		.insertInto("instance")
		.values({
			id: `inst-${Math.random().toString(36).slice(2, 10)}`,
			organizationId,
			hostId,
			name: `afk-${port}`,
			minecraftAccount: "a@b.com",
			minecraftUsername: null,
			liveControlPort: port,
		})
		.returningAll()
		.executeTakeFirstOrThrow()
	trackInstanceId(row.id)
	return row.id
}

const keep = async (
	organizationId: string,
	instanceId: string,
	content: Buffer,
	collectedAt: Date,
	kind: InstanceArtifactKind = "playerList",
) =>
	await repo.store(
		{ organizationId },
		{ instanceId, kind, content, digest: content.toString("hex"), collectedAt },
	)

beforeAll(async () => {
	ownerOrg = await seedOrganization("artifact-owner")
	otherOrg = await seedOrganization("artifact-other")
	ownerInstance = await seedInstance(ownerOrg, 34401)
	otherInstance = await seedInstance(otherOrg, 34402)
})

afterAll(async () => {
	await teardownTestDb()
})

describe("keeping what a host wrote", () => {
	it("stores the bytes unchanged, so a binary replay survives the round trip", async () => {
		const content = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff, 0x7f, 0x80])
		expect(await keep(ownerOrg, ownerInstance, content, new Date(), "replay")).toBe(true)

		const stored = await repo.listSummaries({ organizationId: ownerOrg }, ownerInstance)
		const replay = stored.find((row) => row.kind === "replay")
		if (replay === undefined) throw new Error("expected the replay back")
		expect(replay.byteSize).toBe(content.length)
		expect(await repo.contentOf({ organizationId: ownerOrg }, replay.id)).toEqual(content)
	})

	it("keeps the same bytes once, so a drain that failed cannot double them on the next sweep", async () => {
		const content = Buffer.from("alice, bob\n")
		expect(await keep(ownerOrg, ownerInstance, content, new Date())).toBe(true)
		expect(await keep(ownerOrg, ownerInstance, content, new Date())).toBe(false)

		const stored = await repo.listSummaries({ organizationId: ownerOrg }, ownerInstance)
		expect(stored.filter((row) => row.byteSize === content.length)).toHaveLength(1)
	})

	it("shows one organization nothing another organization collected", async () => {
		const content = Buffer.from("their roster\n")
		await keep(otherOrg, otherInstance, content, new Date())

		expect(await repo.listSummaries({ organizationId: ownerOrg }, otherInstance)).toHaveLength(0)
		const theirs = await repo.listSummaries({ organizationId: otherOrg }, otherInstance)
		const first = theirs[0]
		if (first === undefined) throw new Error("expected their own row back")
		expect(await repo.contentOf({ organizationId: ownerOrg }, first.id)).toBeUndefined()
	})
})

describe("bounding what the control plane holds", () => {
	it("drops everything past the number of artifacts kept for a kind", async () => {
		const instanceId = await seedInstance(ownerOrg, 34403)
		for (let index = 0; index < 5; index += 1) {
			await keep(ownerOrg, instanceId, Buffer.from(`roster ${index}\n`), new Date(1000 + index))
		}

		expect(
			await repo.deleteBeyondKept({ organizationId: ownerOrg }, instanceId, "playerList", 2),
		).toBe(3)
		const left = await repo.listSummaries({ organizationId: ownerOrg }, instanceId)
		expect(left).toHaveLength(2)
		expect(left.map((row) => row.collectedAt)).toEqual([new Date(1004), new Date(1003)])
	})

	it("counts only the kind it was asked to bound", async () => {
		const instanceId = await seedInstance(ownerOrg, 34404)
		await keep(ownerOrg, instanceId, Buffer.from("roster\n"), new Date(2000))
		await keep(ownerOrg, instanceId, Buffer.from("replay"), new Date(2001), "replay")

		expect(
			await repo.deleteBeyondKept({ organizationId: ownerOrg }, instanceId, "playerList", 0),
		).toBe(1)
		expect(await repo.listSummaries({ organizationId: ownerOrg }, instanceId)).toHaveLength(1)
	})

	it("removes everything collected before the retention cutoff", async () => {
		const instanceId = await seedInstance(ownerOrg, 34405)
		await keep(ownerOrg, instanceId, Buffer.from("old\n"), new Date(1_000_000))
		await keep(ownerOrg, instanceId, Buffer.from("new\n"), new Date(9_000_000))

		expect(
			await repo.deleteCollectedBefore({ organizationId: ownerOrg }, new Date(5_000_000)),
		).toBeGreaterThanOrEqual(1)
		const left = await repo.listSummaries({ organizationId: ownerOrg }, instanceId)
		expect(left.map((row) => row.collectedAt)).toEqual([new Date(9_000_000)])
	})

	it("leaves another organization's rows alone when one organization's retention runs", async () => {
		const theirs = await keep(otherOrg, otherInstance, Buffer.from("keep me\n"), new Date(1_000))
		expect(theirs).toBe(true)

		await repo.deleteCollectedBefore({ organizationId: ownerOrg }, new Date(9_999_999))

		const left = await repo.listSummaries({ organizationId: otherOrg }, otherInstance)
		expect(left.some((row) => row.collectedAt.getTime() === 1_000)).toBe(true)
	})
})
