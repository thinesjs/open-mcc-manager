import { afterAll, describe, expect, it } from "vitest"
import { createDb } from "../client"

const requireTestDatabaseUrl = (): string => {
	const url = process.env.TEST_DATABASE_URL
	if (!url) throw new Error("TEST_DATABASE_URL is required to run repository tests")
	return url
}

const db = createDb(requireTestDatabaseUrl())

afterAll(async () => {
	await db.destroy()
})

const columnNames = async (tableName: string): Promise<string[]> => {
	const tables = await db.introspection.getTables()
	const table = tables.find((t) => t.name === tableName)
	if (!table) throw new Error(`table not found: ${tableName}`)
	return table.columns.map((c) => c.name)
}

describe("schema tenant invariant", () => {
	it("carries organizationId on every domain table", async () => {
		for (const tableName of ["sshKey", "host", "auditEvent"]) {
			expect(await columnNames(tableName)).toContain("organizationId")
		}
	})

	it("records host key trust provenance", async () => {
		const names = await columnNames("host")
		expect(names).toContain("hostKeyFingerprint")
		expect(names).toContain("hostKeyAlgorithm")
		expect(names).toContain("hostKeyTrustedBy")
		expect(names).toContain("hostKeyTrustedAt")
	})

	it("gives each encrypted column its own key id", async () => {
		const names = await columnNames("sshKey")
		expect(names).toContain("privateKeyEncrypted")
		expect(names).toContain("privateKeyKeyId")
	})
})
