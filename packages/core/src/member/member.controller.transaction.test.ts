import { sql } from "kysely"
import { afterAll, describe, expect, it } from "vitest"
import { seedMember, seedOrganization, teardownTestDb, testDb } from "../test/db"
import {
	createMemberController,
	createMemberControllerTransaction,
	LastOwnerError,
} from "./member.controller"
import { createMemberRepository } from "./member.repository"

afterAll(async () => {
	await teardownTestDb()
})

const seedOwner = async (organizationId: string): Promise<string> => {
	const id = await seedMember(organizationId)
	await testDb().updateTable("member").set({ role: "owner" }).where("id", "=", id).execute()
	return id
}

const someoneIsWaitingOnALock = async (): Promise<boolean> => {
	const result = await sql<{ waiting: string }>`
		select count(*)::text as waiting from pg_stat_activity
		where datname = current_database()
		and wait_event_type = 'Lock'
		and query like '%pg_advisory_xact_lock%'
	`.execute(testDb())
	return result.rows[0]?.waiting !== "0"
}

const waitUntil = async (condition: () => Promise<boolean>, budgetMs: number): Promise<void> => {
	const deadline = Date.now() + budgetMs
	while (Date.now() < deadline) {
		if (await condition()) return
		await new Promise((resolve) => setTimeout(resolve, 20))
	}
}

describe("two owners removing each other at once", () => {
	it("leaves one owner, because the second removal counts owners after the first has committed", async () => {
		const organizationId = await seedOrganization("owners-race")
		const first = await seedOwner(organizationId)
		const second = await seedOwner(organizationId)
		const scope = { organizationId }
		const controller = createMemberController({
			members: createMemberRepository(testDb()),
			withTransaction: createMemberControllerTransaction(testDb()),
			revokeSessions: async () => undefined,
		})

		let removal: Promise<boolean> | undefined
		await testDb()
			.transaction()
			.execute(async (tx) => {
				const members = createMemberRepository(tx)
				await members.lock(scope)
				await members.delete(scope, first)
				removal = controller.remove(
					{ organizationId, memberId: first, actorLabel: "first@example.com", role: "owner" },
					second,
				)
				removal.catch(() => undefined)
				await waitUntil(someoneIsWaitingOnALock, 5_000)
			})

		await expect(removal).rejects.toBeInstanceOf(LastOwnerError)
		const owners = await createMemberRepository(testDb()).countOwners(scope)
		expect(owners).toBe(1)
		expect(await createMemberRepository(testDb()).findById(scope, second)).toBeDefined()
	})
})
