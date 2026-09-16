import type { Role } from "@open-mcc/contracts"
import type {
	AuditController,
	BuildInfo,
	DestinationController,
	HostController,
	InstanceController,
	MemberController,
	ProcessIdentityRepository,
	SelfHostController,
	SshKeyController,
	StatusController,
	UpdateStateRepository,
} from "@open-mcc/core"
import type { Db } from "@open-mcc/db"
import type { Auth } from "./auth"

export type Actor = {
	organizationId: string
	memberId: string
	actorLabel: string
	role: Role
}

export type RequestContext = {
	actor: Actor | null
	auth: Auth
	signupAuth: Auth
	headers: Headers
	hostController: HostController
	processIdentities: ProcessIdentityRepository
	build: BuildInfo
	schemaVersion: string
	instanceController: InstanceController
	statusController: StatusController
	sshKeyController: SshKeyController
	selfHostController: SelfHostController
	destinationController: DestinationController
	memberController: MemberController
	updateStates: UpdateStateRepository
	auditController: AuditController
	db: Db
}
