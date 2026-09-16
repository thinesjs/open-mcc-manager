import { isRole } from "@open-mcc/contracts"
import type {
	BuildInfo,
	DestinationController,
	HostController,
	InstanceController,
	MemberController,
	ProcessIdentityRepository,
	SelfHostController,
	SshKeyController,
	StatusController,
} from "@open-mcc/core"
import {
	createAuditController,
	createAuditControllerTransaction,
	createUpdateStateRepository,
} from "@open-mcc/core"
import type { Db } from "@open-mcc/db"
import type { Auth } from "./auth"
import type { Actor, RequestContext } from "./context"

export type AppDeps = {
	auth: Auth
	signupAuth: Auth
	db: Db
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
}

const resolveActor = async (deps: AppDeps, headers: Headers): Promise<Actor | null> => {
	const session = await deps.auth.api.getSession({ headers })
	if (!session) return null

	const activeOrganizationId = session.session.activeOrganizationId
	if (!activeOrganizationId) return null

	const email = session.user.email
	if (email.trim().length === 0) return null

	const member = await deps.db
		.selectFrom("member")
		.select(["id", "role"])
		.where("organizationId", "=", activeOrganizationId)
		.where("userId", "=", session.user.id)
		.executeTakeFirst()
	if (!member) return null
	if (!isRole(member.role)) return null

	return {
		organizationId: activeOrganizationId,
		memberId: member.id,
		actorLabel: email,
		role: member.role,
	}
}

export const createRequestContext = (deps: AppDeps) => {
	const updateStates = createUpdateStateRepository(deps.db)
	const auditController = createAuditController({
		withTransaction: createAuditControllerTransaction(deps.db),
	})
	return async (opts: { req: Request }): Promise<RequestContext> => {
		const actor = await resolveActor(deps, opts.req.headers)
		return {
			actor,
			auth: deps.auth,
			signupAuth: deps.signupAuth,
			headers: opts.req.headers,
			hostController: deps.hostController,
			processIdentities: deps.processIdentities,
			build: deps.build,
			schemaVersion: deps.schemaVersion,
			instanceController: deps.instanceController,
			statusController: deps.statusController,
			sshKeyController: deps.sshKeyController,
			selfHostController: deps.selfHostController,
			destinationController: deps.destinationController,
			memberController: deps.memberController,
			updateStates,
			auditController,
			db: deps.db,
		}
	}
}
