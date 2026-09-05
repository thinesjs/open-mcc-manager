import {
	createAuditRepository,
	createHostTeardownHandler,
	createSecretStore,
	createSshKeyRepository,
	HOST_TEARDOWN_QUEUE,
} from "@open-mcc/core"
import { createDb, type Db } from "@open-mcc/db"
import { createSshTransport } from "@open-mcc/transport"
import type { Job } from "pg-boss"
import { PgBoss } from "pg-boss"
import type { WorkerEnv } from "./env"

export const CONNECT_TIMEOUT_MS = 10_000

export type WorkerHandle = {
	stop: () => Promise<void>
	db: Db
	boss: PgBoss
}

export const startWorker = async (env: WorkerEnv): Promise<WorkerHandle> => {
	const db = createDb(env.DATABASE_URL)
	const secrets = await createSecretStore(env.SEALBOX_KEYS)
	const sshKeys = createSshKeyRepository(db)
	const audit = createAuditRepository(db)

	const boss = new PgBoss({ connectionString: env.DATABASE_URL })
	boss.on("error", (error: Error) => {
		console.error("Job queue error", error.message)
	})
	await boss.start()
	await boss.createQueue(HOST_TEARDOWN_QUEUE)

	const teardown = createHostTeardownHandler({
		openKey: async (organizationId, sshKeyId) => {
			const key = await sshKeys.findById({ organizationId }, sshKeyId)
			if (!key) return undefined
			return { privateKey: secrets.open(key.privateKeyEncrypted, key.privateKeyKeyId) }
		},
		connect: async (options) => {
			const transport = createSshTransport()
			await transport.connect({ ...options, timeoutMs: CONNECT_TIMEOUT_MS })
			return transport
		},
		onCleaned: async (hostId, summary) => {
			await audit
				.record(
					{ organizationId: summary.organizationId ?? "" },
					{
						actorId: null,
						actorLabel: "worker",
						action: "host.teardown",
						subjectType: "host",
						subjectId: hostId,
						detail: summary,
					},
				)
				.catch(() => undefined)
		},
	})

	await boss.work(HOST_TEARDOWN_QUEUE, async (jobs: Job[]) => {
		for (const job of jobs) {
			await teardown(job.data)
		}
	})

	return {
		db,
		boss,
		stop: async () => {
			await boss.stop()
			await db.destroy()
		},
	}
}
