import type { Role } from "@open-mcc/contracts"
import type { HostController, InstanceController, SshKeyController } from "@open-mcc/core"
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
	instanceController: InstanceController
	sshKeyController: SshKeyController
	db: Db
}
