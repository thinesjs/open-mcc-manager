import { randomUUID } from "node:crypto"
import { createDb, type Db } from "@open-mcc/db"
import { InternalError } from "../lib/errors"

let db: Db | undefined

export const testDb = (): Db => {
	const url = process.env.TEST_DATABASE_URL
	if (!url) throw new InternalError("TEST_DATABASE_URL is required to run repository tests")
	if (!db) db = createDb(url)
	return db
}

type SeededIds = {
	organizationIds: string[]
	userIds: string[]
	memberIds: string[]
	hostIds: string[]
	sshKeyIds: string[]
	auditEventIds: string[]
	instanceIds: string[]
	instanceConfigIds: string[]
}

const seeded: SeededIds = {
	organizationIds: [],
	userIds: [],
	memberIds: [],
	hostIds: [],
	sshKeyIds: [],
	auditEventIds: [],
	instanceIds: [],
	instanceConfigIds: [],
}

export const seedOrganization = async (slugPrefix: string): Promise<string> => {
	const id = randomUUID()
	await testDb()
		.insertInto("organization")
		.values({ id, name: slugPrefix, slug: `${slugPrefix}-${id.slice(0, 8)}` })
		.execute()
	seeded.organizationIds.push(id)
	return id
}

export const seedMember = async (organizationId: string): Promise<string> => {
	const userId = randomUUID()
	await testDb()
		.insertInto("user")
		.values({ id: userId, name: "actor", email: `${userId}@example.com` })
		.execute()
	seeded.userIds.push(userId)
	const memberId = randomUUID()
	await testDb().insertInto("member").values({ id: memberId, organizationId, userId }).execute()
	seeded.memberIds.push(memberId)
	return memberId
}

export const trackHostId = (id: string): void => {
	seeded.hostIds.push(id)
}

export const trackSshKeyId = (id: string): void => {
	seeded.sshKeyIds.push(id)
}

export const trackAuditEventId = (id: string): void => {
	seeded.auditEventIds.push(id)
}

export const trackInstanceId = (id: string): void => {
	seeded.instanceIds.push(id)
}

export const trackInstanceConfigId = (id: string): void => {
	seeded.instanceConfigIds.push(id)
}

const deleteTrackedRows = async (): Promise<void> => {
	const steps: Array<() => Promise<void>> = [
		async () => {
			if (seeded.instanceConfigIds.length > 0) {
				await testDb()
					.deleteFrom("instanceConfig")
					.where("id", "in", seeded.instanceConfigIds)
					.execute()
			}
		},
		async () => {
			if (seeded.instanceIds.length > 0) {
				await testDb().deleteFrom("instance").where("id", "in", seeded.instanceIds).execute()
			}
		},
		async () => {
			if (seeded.auditEventIds.length > 0) {
				await testDb().deleteFrom("auditEvent").where("id", "in", seeded.auditEventIds).execute()
			}
		},
		async () => {
			if (seeded.hostIds.length > 0) {
				await testDb().deleteFrom("host").where("id", "in", seeded.hostIds).execute()
			}
		},
		async () => {
			if (seeded.sshKeyIds.length > 0) {
				await testDb().deleteFrom("sshKey").where("id", "in", seeded.sshKeyIds).execute()
			}
		},
		async () => {
			if (seeded.memberIds.length > 0) {
				await testDb().deleteFrom("member").where("id", "in", seeded.memberIds).execute()
			}
		},
		async () => {
			if (seeded.userIds.length > 0) {
				await testDb().deleteFrom("user").where("id", "in", seeded.userIds).execute()
			}
		},
		async () => {
			if (seeded.organizationIds.length > 0) {
				await testDb()
					.deleteFrom("organization")
					.where("id", "in", seeded.organizationIds)
					.execute()
			}
		},
	]

	for (const step of steps) {
		try {
			await step()
		} catch (error) {
			console.error("teardownTestDb: cleanup step failed", error)
		}
	}

	seeded.organizationIds = []
	seeded.userIds = []
	seeded.memberIds = []
	seeded.hostIds = []
	seeded.sshKeyIds = []
	seeded.auditEventIds = []
	seeded.instanceIds = []
	seeded.instanceConfigIds = []
}

export const teardownTestDb = async (): Promise<void> => {
	await deleteTrackedRows()
	const client = db
	db = undefined
	if (client) {
		try {
			await client.destroy()
		} catch (error) {
			console.error("teardownTestDb: failed to close connection", error)
		}
	}
}
