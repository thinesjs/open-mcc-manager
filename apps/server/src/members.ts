import {
	createMemberController,
	createMemberControllerTransaction,
	createMemberRepository,
	type OrgScope,
} from "@open-mcc/core"
import type { Db } from "@open-mcc/db"
import type { Auth } from "./auth"

export const revokeOrganizationSessions =
	(auth: Auth) =>
	async (scope: OrgScope, userId: string): Promise<void> => {
		const { internalAdapter } = await auth.$context
		const sessions = await internalAdapter.listSessions(userId)
		const tokens = sessions
			.filter(
				(session) =>
					"activeOrganizationId" in session &&
					session.activeOrganizationId === scope.organizationId,
			)
			.map((session) => session.token)
		if (tokens.length > 0) await internalAdapter.deleteSessions(tokens)
	}

export const memberControllerFor = (db: Db, auth: Auth) =>
	createMemberController({
		members: createMemberRepository(db),
		withTransaction: createMemberControllerTransaction(db),
		revokeSessions: revokeOrganizationSessions(auth),
	})
