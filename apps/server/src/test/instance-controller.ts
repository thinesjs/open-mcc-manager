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
	type SecretStore,
} from "@open-mcc/core"
import type { Db } from "@open-mcc/db"
import {
	createFakeTransport,
	createReadConnections,
	type FakeScript,
	READ_CONNECTION_CHANNEL_LIMIT,
	READ_CONNECTION_HARD_AGE_MS,
	READ_CONNECTION_IDLE_MS,
} from "@open-mcc/transport"

export const createTestInstanceController = async (
	db: Db,
	secrets?: SecretStore,
	script: FakeScript = {},
	collect: (transport: ReturnType<typeof createFakeTransport>) => void = () => undefined,
) =>
	createInstanceController({
		instances: createInstanceRepository(db),
		schedules: createScheduleRepository(db),
		commands: createCommandRepository(db),
		hosts: createHostRepository(db),
		sshKeys: createSshKeyRepository(db),
		secrets: secrets ?? (await createSecretStore(await generateKeyPair("k1"))),
		createTransport: () => {
			const transport = createFakeTransport(script)
			collect(transport)
			return transport
		},
		readConnections: createReadConnections({
			createTransport: () => createFakeTransport(),
			idleMs: READ_CONNECTION_IDLE_MS,
			hardAgeMs: READ_CONNECTION_HARD_AGE_MS,
			channelLimit: READ_CONNECTION_CHANNEL_LIMIT,
			now: () => Date.now(),
		}),
		withTransaction: createInstanceControllerTransaction(db),
		now: () => Date.now(),
	})
