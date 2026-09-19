import {
	createMemberController,
	createMemberControllerTransaction,
	createMemberRepository,
	type OrgScope,
	type RuntimeErrorReporter,
} from "@open-mcc/core"
import type { Db } from "@open-mcc/db"
import type { Auth } from "./auth"

export const endRemovedMemberAccess =
	(auth: Auth) =>
	async (scope: OrgScope, userId: string): Promise<void> => {
		const { adapter, internalAdapter } = await auth.$context
		const memberships = await adapter.count({
			model: "member",
			where: [{ field: "userId", value: userId }],
		})
		if (memberships === 0) {
			await internalAdapter.deleteUser(userId)
			return
		}
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

export const memberControllerFor = (db: Db, auth: Auth, reportError: RuntimeErrorReporter) =>
	createMemberController({
		members: createMemberRepository(db),
		withTransaction: createMemberControllerTransaction(db),
		revokeSessions: endRemovedMemberAccess(auth),
		reportError,
	})
