import { randomUUID } from "node:crypto"
import { auditEvent, createDb, type Db, host, organization, sshKey } from "@open-mcc/db"
import { inArray } from "drizzle-orm"

let db: Db | undefined

export const testDb = (): Db => {
	const url = process.env.TEST_DATABASE_URL
	if (!url) throw new Error("TEST_DATABASE_URL is required to run repository tests")
	if (!db) db = createDb(url)
	return db
}

type SeededIds = {
	organizationIds: string[]
	hostIds: string[]
	sshKeyIds: string[]
	auditEventIds: string[]
}

const seeded: SeededIds = {
	organizationIds: [],
	hostIds: [],
	sshKeyIds: [],
	auditEventIds: [],
}

export const seedOrganization = async (slugPrefix: string): Promise<string> => {
	const id = randomUUID()
	await testDb()
		.insert(organization)
		.values({ id, name: slugPrefix, slug: `${slugPrefix}-${id.slice(0, 8)}` })
	seeded.organizationIds.push(id)
	return id
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

const deleteTrackedRows = async (): Promise<void> => {
	const steps: Array<() => Promise<void>> = [
		async () => {
			if (seeded.auditEventIds.length > 0) {
				await testDb().delete(auditEvent).where(inArray(auditEvent.id, seeded.auditEventIds))
			}
		},
		async () => {
			if (seeded.hostIds.length > 0) {
				await testDb().delete(host).where(inArray(host.id, seeded.hostIds))
			}
		},
		async () => {
			if (seeded.sshKeyIds.length > 0) {
				await testDb().delete(sshKey).where(inArray(sshKey.id, seeded.sshKeyIds))
			}
		},
		async () => {
			if (seeded.organizationIds.length > 0) {
				await testDb().delete(organization).where(inArray(organization.id, seeded.organizationIds))
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
	seeded.hostIds = []
	seeded.sshKeyIds = []
	seeded.auditEventIds = []
}

export const teardownTestDb = async (): Promise<void> => {
	await deleteTrackedRows()
	const client = db
	db = undefined
	if (client) {
		try {
			await client.$client.end()
		} catch (error) {
			console.error("teardownTestDb: failed to close connection", error)
		}
	}
}
