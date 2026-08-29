import { getTableConfig } from "drizzle-orm/pg-core"
import { describe, expect, it } from "vitest"
import { auditEvent, host, sshKey } from "./index"

const columnNames = (table: Parameters<typeof getTableConfig>[0]): string[] =>
	getTableConfig(table).columns.map((c) => c.name)

describe("schema tenant invariant", () => {
	it("carries organizationId on every domain table", () => {
		for (const table of [sshKey, host, auditEvent]) {
			expect(columnNames(table)).toContain("organizationId")
		}
	})

	it("records host key trust provenance", () => {
		const names = columnNames(host)
		expect(names).toContain("hostKeyFingerprint")
		expect(names).toContain("hostKeyAlgorithm")
		expect(names).toContain("hostKeyTrustedBy")
		expect(names).toContain("hostKeyTrustedAt")
	})

	it("gives each encrypted column its own key id", () => {
		expect(columnNames(sshKey)).toContain("privateKeyEncrypted")
		expect(columnNames(sshKey)).toContain("privateKeyKeyId")
	})
})
