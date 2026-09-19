import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { seedOrganization, teardownTestDb, testDb } from "../test/db"
import { createOrganizationRepository } from "./organization.repository"

const repo = createOrganizationRepository(testDb())

let orgA = ""
let orgB = ""

beforeAll(async () => {
	orgA = await seedOrganization("org-list-a")
	orgB = await seedOrganization("org-list-b")
})

afterAll(async () => {
	await teardownTestDb()
})

describe("the scopes a fleet-wide job runs against", () => {
	it("names every organization, because a background job holds no actor to scope against", async () => {
		const ids = await repo.listIds()

		expect(ids).toContain(orgA)
		expect(ids).toContain(orgB)
	})
})
