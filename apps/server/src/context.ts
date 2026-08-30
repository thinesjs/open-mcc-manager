import type { Role } from "@open-mcc/contracts"
import type { HostController, SecretStore, SshKeyRepository } from "@open-mcc/core"
import type { Db } from "@open-mcc/db"

export type Actor = {
	organizationId: string
	memberId: string
	actorLabel: string
	role: Role
}

export type RequestContext = {
	actor: Actor | null
	hostController: HostController
	sshKeys: SshKeyRepository
	secrets: SecretStore
	db: Db
}
