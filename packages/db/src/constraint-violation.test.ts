import { randomUUID } from "node:crypto"
import { sql } from "kysely"
import { afterAll, afterEach, describe, expect, it } from "vitest"
import { createDb } from "./client"
import { type ConstraintViolation, constraintViolationOf } from "./constraint-violation"

const requireTestDatabaseUrl = (): string => {
	const url = process.env.TEST_DATABASE_URL
	if (!url) throw new Error("TEST_DATABASE_URL is required to run repository tests")
	return url
}

const db = createDb(requireTestDatabaseUrl())

const organizationIds: string[] = []

afterEach(async () => {
	const created = organizationIds.splice(0, organizationIds.length)
	if (created.length === 0) return
	await db.deleteFrom("host").where("organizationId", "in", created).execute()
	await db.deleteFrom("sshKey").where("organizationId", "in", created).execute()
	await db.deleteFrom("organization").where("id", "in", created).execute()
})

afterAll(async () => {
	await db.destroy()
})

const seedOrganization = async (): Promise<string> => {
	const id = randomUUID()
	await db
		.insertInto("organization")
		.values({ id, name: "constraint org", slug: `org-${id}` })
		.execute()
	organizationIds.push(id)
	return id
}

const seedSshKey = async (organizationId: string, name: string): Promise<string> => {
	const id = randomUUID()
	await db
		.insertInto("sshKey")
		.values({
			id,
			organizationId,
			name,
			publicKey: "ssh-ed25519 AAAAtest",
			privateKeyEncrypted: "sealed",
			privateKeyKeyId: "k1",
		})
		.execute()
	return id
}

const seedHost = async (organizationId: string, name: string, sshKeyId: string): Promise<void> => {
	await db
		.insertInto("host")
		.values({ id: randomUUID(), organizationId, name, hostname: "10.0.0.1", sshKeyId })
		.execute()
}

const classifyThrown = async (run: () => Promise<void>): Promise<ConstraintViolation | null> => {
	try {
		await run()
	} catch (error) {
		if (!(error instanceof Error)) throw new Error("the driver threw a value that is not an Error")
		return constraintViolationOf(error)
	}
	throw new Error("the statement was expected to fail")
}

describe("constraintViolationOf", () => {
	it("classifies a restricted delete of an ssh key a host still references", async () => {
		const organizationId = await seedOrganization()
		const sshKeyId = await seedSshKey(organizationId, "in-use")
		await seedHost(organizationId, "vps-1", sshKeyId)

		const violation = await classifyThrown(async () => {
			await db.deleteFrom("sshKey").where("id", "=", sshKeyId).execute()
		})

		expect(violation).toEqual({ kind: "foreignKey", constraint: "host_sshKey_org_fk" })
	})

	it("classifies a duplicate host name within one organization", async () => {
		const organizationId = await seedOrganization()
		const sshKeyId = await seedSshKey(organizationId, "for-hosts")
		await seedHost(organizationId, "vps-duplicate", sshKeyId)

		const violation = await classifyThrown(() =>
			seedHost(organizationId, "vps-duplicate", sshKeyId),
		)

		expect(violation).toEqual({ kind: "unique", constraint: "host_org_name_unique" })
	})

	it("classifies a duplicate ssh key name within one organization", async () => {
		const organizationId = await seedOrganization()
		await seedSshKey(organizationId, "duplicate")

		const violation = await classifyThrown(async () => {
			await seedSshKey(organizationId, "duplicate")
		})

		expect(violation).toEqual({ kind: "unique", constraint: "sshKey_org_name_unique" })
	})

	it("classifies a foreign key pointing at another organization's ssh key", async () => {
		const first = await seedOrganization()
		const second = await seedOrganization()
		const foreignKeyId = await seedSshKey(first, "other-tenant")

		const violation = await classifyThrown(() => seedHost(second, "vps-cross", foreignKeyId))

		expect(violation).toEqual({ kind: "foreignKey", constraint: "host_sshKey_org_fk" })
	})

	it("leaves a not-null violation unclassified, since it reports a server defect rather than a conflict", async () => {
		const organizationId = await seedOrganization()

		const violation = await classifyThrown(async () => {
			await sql`insert into "host" ("id", "organizationId", "name") values (${randomUUID()}, ${organizationId}, ${"vps-null"})`.execute(
				db,
			)
		})

		expect(violation).toBe(null)
	})

	it("leaves an error outside the integrity constraint class unclassified", async () => {
		const violation = await classifyThrown(async () => {
			await sql`select * from table_that_does_not_exist`.execute(db)
		})

		expect(violation).toBe(null)
	})

	it("leaves an error that never came from the driver unclassified", () => {
		expect(constraintViolationOf(new Error("duplicate key value violates unique constraint"))).toBe(
			null,
		)
	})
})
