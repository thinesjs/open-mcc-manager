import {
	createSelfHostController,
	createSshKeyControllerTransaction,
	createSshKeyRepository,
	type HostController,
	type SelfHostMaterials,
} from "@open-mcc/core"
import type { Db } from "@open-mcc/db"

const refuseEnrolment: HostController["enroll"] = async () => {
	throw new Error("host enrolment should not be reached in this test")
}

export const createTestSelfHostController = (
	db: Db,
	enroll: HostController["enroll"] = refuseEnrolment,
	materials?: SelfHostMaterials,
) =>
	createSelfHostController({
		materials,
		sshKeys: createSshKeyRepository(db),
		withSshKeyTransaction: createSshKeyControllerTransaction(db),
		enroll,
	})
