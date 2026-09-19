import {
	createHostRepository,
	createStatusController,
	createStatusControllerTransaction,
	type SendJob,
} from "@open-mcc/core"
import type { Db } from "@open-mcc/db"

export const createTestStatusController = (db: Db, sendJob: SendJob = async () => "job") => {
	const hosts = createHostRepository(db)
	return createStatusController({
		withTransaction: createStatusControllerTransaction(db),
		sendJob,
		hostNames: async (scope) =>
			(await hosts.list(scope)).map((host) => ({ id: host.id, name: host.name })),
		instanceNames: async () => [],
		retentionDays: 30,
		now: () => new Date(),
	})
}
