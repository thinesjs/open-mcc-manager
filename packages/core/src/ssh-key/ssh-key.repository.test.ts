import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { seedOrganization, teardownTestDb, testDb, trackSshKeyId } from "../test/db"
import { createSshKeyRepository } from "./ssh-key.repository"

const repo = createSshKeyRepository(testDb())
let orgA = ""
let orgB = ""

beforeAll(async () => {
	orgA = await seedOrganization("org-a")
	orgB = await seedOrganization("org-b")
})

afterAll(async () => {
	await teardownTestDb()
})

describe("ssh key repository organization scoping", () => {
	it("returns an ssh key to its own organization", async () => {
		const created = await repo.insert(
			{ organizationId: orgA },
			{
				name: "key-1",
				publicKey: "ssh-ed25519 AAAA...",
				privateKeyEncrypted: "sealed-1",
				privateKeyKeyId: "k1",
			},
		)
		trackSshKeyId(created.id)
		const found = await repo.findById({ organizationId: orgA }, created.id)
		expect(found?.name).toBe("key-1")
	})

	it("hides that ssh key from another organization", async () => {
		const created = await repo.insert(
			{ organizationId: orgA },
			{
				name: "key-2",
				publicKey: "ssh-ed25519 BBBB...",
				privateKeyEncrypted: "sealed-2",
				privateKeyKeyId: "k1",
			},
		)
		trackSshKeyId(created.id)
		expect(await repo.findById({ organizationId: orgB }, created.id)).toBeUndefined()
	})

	it("never lists another organization's ssh keys", async () => {
		const created = await repo.insert(
			{ organizationId: orgA },
			{
				name: "key-3",
				publicKey: "ssh-ed25519 CCCC...",
				privateKeyEncrypted: "sealed-3",
				privateKeyKeyId: "k1",
			},
		)
		trackSshKeyId(created.id)
		expect(await repo.list({ organizationId: orgB })).toEqual([])
	})

	it("refuses to delete across organizations", async () => {
		const created = await repo.insert(
			{ organizationId: orgA },
			{
				name: "key-4",
				publicKey: "ssh-ed25519 DDDD...",
				privateKeyEncrypted: "sealed-4",
				privateKeyKeyId: "k1",
			},
		)
		trackSshKeyId(created.id)
		const deleted = await repo.delete({ organizationId: orgB }, created.id)
		expect(deleted).toBe(false)
		const stillThere = await repo.findById({ organizationId: orgA }, created.id)
		expect(stillThere?.name).toBe("key-4")
	})
})
