import {
	createDestinationController,
	createDestinationControllerTransaction,
	createNotificationRepository,
	PUBLIC_ONLY,
	type SecretStore,
	type SendJob,
} from "@open-mcc/core"
import type { Db } from "@open-mcc/db"

export const createTestDestinationController = (
	db: Db,
	secrets: SecretStore,
	sendJob: SendJob = async () => "job",
) =>
	createDestinationController({
		withTransaction: createDestinationControllerTransaction(db),
		notifications: createNotificationRepository(db),
		secrets,
		sendJob,
		policy: PUBLIC_ONLY,
	})
