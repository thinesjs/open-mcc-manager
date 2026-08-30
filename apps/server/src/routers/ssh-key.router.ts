import { createSshKeyInput, type SshKeyPublic, sshKeyIdInput } from "@open-mcc/contracts"
import { createAuditRepository, createSshKeyRepository, generateSshKeyPair } from "@open-mcc/core"
import type { SshKeyRow } from "@open-mcc/db"
import { protectedProcedure, requireCapability, router } from "../trpc"

const toPublic = (row: SshKeyRow): SshKeyPublic => ({
	id: row.id,
	name: row.name,
	publicKey: row.publicKey,
	createdAt: row.createdAt,
})

export const sshKeyRouter = router({
	list: protectedProcedure.query(async ({ ctx }) => {
		requireCapability(ctx.actor.role, "sshKey.manage")
		const rows = await ctx.sshKeys.list({ organizationId: ctx.actor.organizationId })
		return rows.map(toPublic)
	}),

	create: protectedProcedure.input(createSshKeyInput).mutation(async ({ ctx, input }) => {
		requireCapability(ctx.actor.role, "sshKey.manage")
		const generated = generateSshKeyPair()
		const sealed = ctx.secrets.seal(generated.privateKey)
		const scope = { organizationId: ctx.actor.organizationId }

		const created = await ctx.db.transaction().execute(async (tx) => {
			const row = await createSshKeyRepository(tx).insert(scope, {
				name: input.name,
				publicKey: generated.publicKey,
				privateKeyEncrypted: sealed.ciphertext,
				privateKeyKeyId: sealed.keyId,
			})
			await createAuditRepository(tx).record(scope, {
				actorId: ctx.actor.memberId,
				actorLabel: ctx.actor.actorLabel,
				action: "sshKey.create",
				subjectType: "sshKey",
				subjectId: row.id,
				detail: { name: input.name },
			})
			return row
		})

		return toPublic(created)
	}),

	remove: protectedProcedure.input(sshKeyIdInput).mutation(async ({ ctx, input }) => {
		requireCapability(ctx.actor.role, "sshKey.manage")
		const scope = { organizationId: ctx.actor.organizationId }

		const deleted = await ctx.db.transaction().execute(async (tx) => {
			const wasDeleted = await createSshKeyRepository(tx).delete(scope, input.sshKeyId)
			if (wasDeleted) {
				await createAuditRepository(tx).record(scope, {
					actorId: ctx.actor.memberId,
					actorLabel: ctx.actor.actorLabel,
					action: "sshKey.delete",
					subjectType: "sshKey",
					subjectId: input.sshKeyId,
					detail: {},
				})
			}
			return wasDeleted
		})

		return { deleted }
	}),
})
