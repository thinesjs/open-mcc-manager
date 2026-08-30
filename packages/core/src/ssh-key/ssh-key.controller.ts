import { type CreateSshKeyInput, can, type SshKeyPublic } from "@open-mcc/contracts"
import { constraintViolationOf, type Db, type SshKeyRow } from "@open-mcc/db"
import { type AuditRepository, createAuditRepository } from "../audit/audit.repository"
import type { SecretStore } from "../crypto/sealed-box"
import { type ActorContext, ForbiddenError } from "../host/host.controller"
import type { GeneratedSshKeyPair } from "./generate"
import { createSshKeyRepository, type SshKeyRepository } from "./ssh-key.repository"

export type SshKeyTransactionRepos = {
	sshKeys: Pick<SshKeyRepository, "insert" | "delete">
	audit: Pick<AuditRepository, "record">
}

export type WithSshKeyTransaction = <T>(
	fn: (repos: SshKeyTransactionRepos) => Promise<T>,
) => Promise<T>

export const createSshKeyControllerTransaction = (db: Db): WithSshKeyTransaction => {
	const withTransaction: WithSshKeyTransaction = (fn) =>
		db
			.transaction()
			.execute((tx) =>
				fn({ sshKeys: createSshKeyRepository(tx), audit: createAuditRepository(tx) }),
			)
	return withTransaction
}

export type SshKeyControllerDeps = {
	sshKeys: Pick<SshKeyRepository, "list">
	secrets: Pick<SecretStore, "seal">
	generateKeyPair: () => GeneratedSshKeyPair
	withTransaction: WithSshKeyTransaction
}

export class SshKeyInUseError extends Error {}

const deleteUnlessInUse = async (
	repos: SshKeyTransactionRepos,
	scope: { organizationId: string },
	sshKeyId: string,
): Promise<boolean> => {
	try {
		return await repos.sshKeys.delete(scope, sshKeyId)
	} catch (error) {
		if (error instanceof Error && constraintViolationOf(error)?.kind === "foreignKey") {
			throw new SshKeyInUseError(`SSH key ${sshKeyId} is still referenced by an enrolled host`)
		}
		throw error
	}
}

const toPublic = (row: SshKeyRow): SshKeyPublic => ({
	id: row.id,
	name: row.name,
	publicKey: row.publicKey,
	createdAt: row.createdAt,
})

export const createSshKeyController = (deps: SshKeyControllerDeps) => ({
	list: async (ctx: ActorContext): Promise<SshKeyPublic[]> => {
		if (!can(ctx.role, "sshKey.manage")) throw new ForbiddenError("Forbidden: sshKey.manage")
		const rows = await deps.sshKeys.list({ organizationId: ctx.organizationId })
		return rows.map(toPublic)
	},

	create: async (ctx: ActorContext, input: CreateSshKeyInput): Promise<SshKeyPublic> => {
		if (!can(ctx.role, "sshKey.manage")) throw new ForbiddenError("Forbidden: sshKey.manage")

		const generated = deps.generateKeyPair()
		const sealed = deps.secrets.seal(generated.privateKey)
		const scope = { organizationId: ctx.organizationId }

		const created = await deps.withTransaction(async (repos) => {
			const row = await repos.sshKeys.insert(scope, {
				name: input.name,
				publicKey: generated.publicKey,
				privateKeyEncrypted: sealed.ciphertext,
				privateKeyKeyId: sealed.keyId,
			})

			await repos.audit.record(scope, {
				actorId: ctx.memberId,
				actorLabel: ctx.actorLabel,
				action: "sshKey.create",
				subjectType: "sshKey",
				subjectId: row.id,
				detail: { name: input.name },
			})

			return row
		})

		return toPublic(created)
	},

	remove: async (ctx: ActorContext, sshKeyId: string): Promise<boolean> => {
		if (!can(ctx.role, "sshKey.manage")) throw new ForbiddenError("Forbidden: sshKey.manage")
		const scope = { organizationId: ctx.organizationId }

		return deps.withTransaction(async (repos) => {
			const removed = await deleteUnlessInUse(repos, scope, sshKeyId)
			if (removed) {
				await repos.audit.record(scope, {
					actorId: ctx.memberId,
					actorLabel: ctx.actorLabel,
					action: "sshKey.delete",
					subjectType: "sshKey",
					subjectId: sshKeyId,
					detail: {},
				})
			}
			return removed
		})
	},
})

export type SshKeyController = ReturnType<typeof createSshKeyController>
