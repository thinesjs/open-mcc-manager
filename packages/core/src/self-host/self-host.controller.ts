import { can, canAdoptSelfHost, type SelfHostOffer } from "@open-mcc/contracts"
import type { SshKeyRow } from "@open-mcc/db"
import { type ActorContext, ForbiddenError, type HostController } from "../host/host.controller"
import type { OrgScope } from "../host/host.repository"
import type { WithSshKeyTransaction } from "../ssh-key/ssh-key.controller"
import type { SshKeyRepository } from "../ssh-key/ssh-key.repository"

export type SelfHostMaterials = {
	offer: SelfHostOffer
	publicKey: string
	privateKeyEncrypted: string
	privateKeyKeyId: string
}

export class SelfHostUnavailableError extends Error {}

export type SelfHostControllerDeps = {
	materials: SelfHostMaterials | undefined
	sshKeys: Pick<SshKeyRepository, "list">
	withSshKeyTransaction: WithSshKeyTransaction
	enroll: HostController["enroll"]
}

const keyFor = async (
	deps: SelfHostControllerDeps,
	ctx: ActorContext,
	scope: OrgScope,
	materials: SelfHostMaterials,
): Promise<SshKeyRow> => {
	const stored = await deps.sshKeys.list(scope)
	const existing = stored.find((row) => row.publicKey === materials.publicKey)
	if (existing) return existing

	return await deps.withSshKeyTransaction(async (repos) => {
		const row = await repos.sshKeys.insert(scope, {
			name: materials.offer.name,
			publicKey: materials.publicKey,
			privateKeyEncrypted: materials.privateKeyEncrypted,
			privateKeyKeyId: materials.privateKeyKeyId,
		})
		await repos.audit.record(scope, {
			actorId: ctx.memberId,
			actorLabel: ctx.actorLabel,
			action: "sshKey.create",
			subjectType: "sshKey",
			subjectId: row.id,
			detail: { name: materials.offer.name, origin: "self-host" },
		})
		return row
	})
}

export const createSelfHostController = (deps: SelfHostControllerDeps) => ({
	offer: async (ctx: ActorContext): Promise<SelfHostOffer | undefined> =>
		can(ctx.role, "host.enroll") ? deps.materials?.offer : undefined,

	adopt: async (ctx: ActorContext) => {
		if (!can(ctx.role, "host.enroll")) throw new ForbiddenError("Forbidden: host.enroll")

		const materials = deps.materials
		if (!materials || !canAdoptSelfHost(materials.offer)) {
			throw new SelfHostUnavailableError("This deployment has no machine of its own to enroll")
		}

		const scope = { organizationId: ctx.organizationId }
		const key = await keyFor(deps, ctx, scope, materials)

		return await deps.enroll(ctx, {
			name: materials.offer.name,
			hostname: materials.offer.hostname,
			port: materials.offer.port,
			username: materials.offer.username,
			mode: materials.offer.mode,
			sshKeyId: key.id,
			expectedFingerprint: materials.offer.fingerprint,
		})
	},
})

export type SelfHostController = ReturnType<typeof createSelfHostController>
