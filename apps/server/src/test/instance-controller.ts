import {
	createCommandRepository,
	createHostRepository,
	createInstanceController,
	createInstanceControllerTransaction,
	createInstanceRepository,
	createScheduleRepository,
	createSecretStore,
	createSshKeyRepository,
	generateKeyPair,
} from "@open-mcc/core"
import type { Db } from "@open-mcc/db"
import { createFakeTransport } from "@open-mcc/transport"

export const createTestInstanceController = async (db: Db) =>
	createInstanceController({
		instances: createInstanceRepository(db),
		schedules: createScheduleRepository(db),
		commands: createCommandRepository(db),
		hosts: createHostRepository(db),
		sshKeys: createSshKeyRepository(db),
		secrets: await createSecretStore(await generateKeyPair("k1")),
		createTransport: () => createFakeTransport(),
		instancesRoot: "/srv/open-mcc",
		withTransaction: createInstanceControllerTransaction(db),
	})
