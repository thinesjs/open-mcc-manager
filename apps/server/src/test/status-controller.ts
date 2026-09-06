import {
	createHostRepository,
	createStatusController,
	createStatusControllerTransaction,
} from "@open-mcc/core"
import type { Db } from "@open-mcc/db"

export const createTestStatusController = (db: Db) => {
	const hosts = createHostRepository(db)
	return createStatusController({
		withTransaction: createStatusControllerTransaction(db),
		hostNames: async (scope) =>
			(await hosts.list(scope)).map((host) => ({ id: host.id, name: host.name })),
		instanceNames: async () => [],
		retentionDays: 30,
		now: () => new Date(),
	})
}
