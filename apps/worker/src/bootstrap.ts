import { randomUUID } from "node:crypto"
import {
	createAuditRepository,
	createHostTeardownHandler,
	createJobRepository,
	createSecretStore,
	createSshKeyRepository,
	HOST_TEARDOWN_KIND,
	type JobRunnerHandle,
	startJobRunner,
} from "@open-mcc/core"
import { createDb, type Db } from "@open-mcc/db"
import { createSshTransport } from "@open-mcc/transport"
import type { WorkerEnv } from "./env"

export const CONNECT_TIMEOUT_MS = 10_000

export type WorkerHandle = {
	stop: () => void
	db: Db
	runner: JobRunnerHandle
}

export const startWorker = async (env: WorkerEnv): Promise<WorkerHandle> => {
	const db = createDb(env.DATABASE_URL)
	const secrets = await createSecretStore(env.SEALBOX_KEYS)
	const jobs = createJobRepository(db)
	const sshKeys = createSshKeyRepository(db)
	const audit = createAuditRepository(db)

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

	const runner = startJobRunner(
		{
			kinds: [HOST_TEARDOWN_KIND],
			handlers: { [HOST_TEARDOWN_KIND]: teardown },
			claimNext: (kind, claimId, now) => jobs.claimNext(kind, claimId, now),
			complete: (id, claimId, at) => jobs.complete(id, claimId, at),
			release: (id, claimId, reason, runAfter, exhausted, at) =>
				jobs.release(id, claimId, reason, runAfter, exhausted, at),
			now: () => new Date(),
			newClaimId: () => randomUUID(),
			onError: (message, error) => {
				console.error(message, error instanceof Error ? error.message : error)
			},
		},
		env.JOB_TICK_MS,
	)

	return {
		db,
		runner,
		stop: () => {
			runner.stop()
			void db.destroy()
		},
	}
}
