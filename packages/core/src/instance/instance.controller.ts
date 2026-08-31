import {
	type CreateInstanceInput,
	can,
	type InstanceConfigInput,
	type Role,
} from "@open-mcc/contracts"
import type { Db, InstanceRow } from "@open-mcc/db"
import type { HostTransport } from "@open-mcc/transport"
import { type AuditRepository, createAuditRepository } from "../audit/audit.repository"
import type { SecretStore } from "../crypto/sealed-box"
import type { HostRepository } from "../host/host.repository"
import type { SshKeyRepository } from "../ssh-key/ssh-key.repository"
import { renderInstanceConfig } from "./config"
import { readConsole, sendCommand } from "./control"
import {
	createInstanceRepository,
	type InstanceRepository,
	isAuthClaimStale,
} from "./instance.repository"
import { renderEnvironmentFile, validateInstanceId } from "./unit"

export type ActorContext = {
	organizationId: string
	memberId: string
	actorLabel: string
	role: Role
}

export type InstanceTransactionRepos = {
	instances: InstanceRepository
	audit: Pick<AuditRepository, "record">
}

export type WithInstanceTransaction = <T>(
	fn: (repos: InstanceTransactionRepos) => Promise<T>,
) => Promise<T>

export const createInstanceControllerTransaction = (db: Db): WithInstanceTransaction => {
	const withTransaction: WithInstanceTransaction = (fn) =>
		db
			.transaction()
			.execute((tx) =>
				fn({ instances: createInstanceRepository(tx), audit: createAuditRepository(tx) }),
			)
	return withTransaction
}

export type InstanceControllerDeps = {
	instances: InstanceRepository
	hosts: Pick<HostRepository, "findById">
	sshKeys: Pick<SshKeyRepository, "findById">
	secrets: SecretStore
	createTransport: () => HostTransport
	instancesRoot: string
	withTransaction: WithInstanceTransaction
}

export const INSTANCE_STEP_TIMEOUT_MS = 15_000
const CONNECT_TIMEOUT_MS = 10_000

export class ForbiddenError extends Error {}
export class InstanceNotFoundError extends Error {}
export class InstanceHostNotFoundError extends Error {}
export class InstanceAuthInProgressError extends Error {}
export class InstanceConcurrentlyModifiedError extends Error {}

const requireCapabilityFor = (role: Role, capability: Parameters<typeof can>[1]): void => {
	if (!can(role, capability)) throw new ForbiddenError(`Role ${role} lacks ${capability}`)
}

const shellQuote = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`

export const createInstanceController = (deps: InstanceControllerDeps) => {
	const scopeOf = (ctx: ActorContext) => ({ organizationId: ctx.organizationId })

	const connectToHost = async (ctx: ActorContext, hostId: string): Promise<HostTransport> => {
		const host = await deps.hosts.findById(scopeOf(ctx), hostId)
		if (!host) throw new InstanceHostNotFoundError(`Host not found: ${hostId}`)
		if (!host.sshKeyId) throw new InstanceHostNotFoundError(`Host ${hostId} has no ssh key`)
		if (!host.hostKeyFingerprint) {
			throw new InstanceHostNotFoundError(`Host ${hostId} has no trusted host key fingerprint`)
		}
		const key = await deps.sshKeys.findById(scopeOf(ctx), host.sshKeyId)
		if (!key) throw new InstanceHostNotFoundError(`Ssh key not found for host ${hostId}`)

		const transport = deps.createTransport()
		await transport.connect({
			hostname: host.hostname,
			port: host.port,
			username: host.username,
			privateKey: deps.secrets.open(key.privateKeyEncrypted, key.privateKeyKeyId),
			expectedFingerprint: host.hostKeyFingerprint,
			timeoutMs: CONNECT_TIMEOUT_MS,
		})
		return transport
	}

	const requireInstance = async (ctx: ActorContext, instanceId: string): Promise<InstanceRow> => {
		const found = await deps.instances.findById(scopeOf(ctx), instanceId)
		if (!found) throw new InstanceNotFoundError(`Instance not found: ${instanceId}`)
		return found
	}

	const unitCommand = async (
		ctx: ActorContext,
		instance: InstanceRow,
		verb: "start" | "stop",
	): Promise<void> => {
		const transport = await connectToHost(ctx, instance.hostId)
		try {
			const result = await transport.exec(
				`systemctl ${verb} ${shellQuote(`open-mcc@${instance.id}`)}`,
				INSTANCE_STEP_TIMEOUT_MS,
			)
			if (result.exitCode !== 0) {
				throw new Error(`Failed to ${verb} instance ${instance.id}: ${result.stderr.trim()}`)
			}
		} finally {
			await transport.close().catch(() => undefined)
		}
	}

	return {
		list: async (ctx: ActorContext): Promise<InstanceRow[]> => {
			requireCapabilityFor(ctx.role, "instance.read")
			return await deps.instances.list(scopeOf(ctx))
		},

		get: async (ctx: ActorContext, instanceId: string): Promise<InstanceRow> => {
			requireCapabilityFor(ctx.role, "instance.read")
			return await requireInstance(ctx, instanceId)
		},

		create: async (ctx: ActorContext, input: CreateInstanceInput): Promise<InstanceRow> => {
			requireCapabilityFor(ctx.role, "instance.create")
			const host = await deps.hosts.findById(scopeOf(ctx), input.hostId)
			if (!host) throw new InstanceHostNotFoundError(`Host not found: ${input.hostId}`)

			const created = await deps.withTransaction(async (repos) => {
				const row = await repos.instances.insert(scopeOf(ctx), {
					hostId: input.hostId,
					name: input.name,
					minecraftAccount: input.minecraftAccount,
					status: "needs_auth",
				})
				await repos.audit.record(scopeOf(ctx), {
					actorId: ctx.memberId,
					actorLabel: ctx.actorLabel,
					action: "instance.create",
					subjectType: "instance",
					subjectId: row.id,
					detail: { hostId: input.hostId, name: input.name },
				})
				return row
			})

			validateInstanceId(created.id)

			const transport = await connectToHost(ctx, input.hostId)
			try {
				const dir = `${deps.instancesRoot}/instances/${created.id}`
				const steps: Array<[string, string, string | undefined]> = [
					[
						`useradd -r -g open-mcc -d ${shellQuote(dir)} -s /usr/sbin/nologin ${shellQuote(`mcc-${created.id}`)} || true`,
						"Failed to create the instance user",
						undefined,
					],
					[
						`install -d -m 2770 -g open-mcc -o ${shellQuote(`mcc-${created.id}`)} ${shellQuote(dir)}`,
						"Failed to create the instance directory",
						undefined,
					],
					[
						`test -p ${shellQuote(`${dir}/control`)} || mkfifo -m 0660 ${shellQuote(`${dir}/control`)}`,
						"Failed to create the control fifo",
						undefined,
					],
					[
						`chown ${shellQuote(`mcc-${created.id}:open-mcc`)} ${shellQuote(`${dir}/control`)}`,
						"Failed to own the control fifo",
						undefined,
					],
					[
						`cat > ${shellQuote(`${dir}/env`)}`,
						"Failed to write the instance environment",
						renderEnvironmentFile({
							serverAddress: input.serverAddress,
							minecraftAccount: input.minecraftAccount,
						}),
					],
				]
				for (const [command, failure, stdin] of steps) {
					const result = await transport.exec(command, INSTANCE_STEP_TIMEOUT_MS, stdin)
					if (result.exitCode !== 0) throw new Error(`${failure}: ${result.stderr.trim()}`)
				}
			} finally {
				await transport.close().catch(() => undefined)
			}

			return created
		},

		start: async (ctx: ActorContext, instanceId: string): Promise<InstanceRow> => {
			requireCapabilityFor(ctx.role, "instance.start")
			const instance = await requireInstance(ctx, instanceId)
			if (instance.status === "needs_auth") {
				throw new InstanceAuthInProgressError(
					`Instance ${instanceId} has not completed its microsoft sign-in`,
				)
			}

			await unitCommand(ctx, instance, "start")

			const updated = await deps.withTransaction(async (repos) => {
				const row = await repos.instances.update(scopeOf(ctx), instanceId, { status: "running" })
				if (!row) {
					throw new InstanceConcurrentlyModifiedError(
						`Instance ${instanceId} changed before it could be started`,
					)
				}
				await repos.audit.record(scopeOf(ctx), {
					actorId: ctx.memberId,
					actorLabel: ctx.actorLabel,
					action: "instance.start",
					subjectType: "instance",
					subjectId: instanceId,
					detail: {},
				})
				return row
			})
			return updated
		},

		stop: async (ctx: ActorContext, instanceId: string): Promise<InstanceRow> => {
			requireCapabilityFor(ctx.role, "instance.start")
			const instance = await requireInstance(ctx, instanceId)

			await unitCommand(ctx, instance, "stop")

			return await deps.withTransaction(async (repos) => {
				const row = await repos.instances.update(scopeOf(ctx), instanceId, { status: "stopped" })
				if (!row) {
					throw new InstanceConcurrentlyModifiedError(
						`Instance ${instanceId} changed before it could be stopped`,
					)
				}
				await repos.audit.record(scopeOf(ctx), {
					actorId: ctx.memberId,
					actorLabel: ctx.actorLabel,
					action: "instance.stop",
					subjectType: "instance",
					subjectId: instanceId,
					detail: {},
				})
				return row
			})
		},

		sendCommand: async (ctx: ActorContext, instanceId: string, command: string): Promise<void> => {
			requireCapabilityFor(ctx.role, "console.write")
			const instance = await requireInstance(ctx, instanceId)

			const transport = await connectToHost(ctx, instance.hostId)
			try {
				await sendCommand(transport, instance.id, command, deps.instancesRoot)
			} finally {
				await transport.close().catch(() => undefined)
			}

			await deps.withTransaction(async (repos) => {
				await repos.audit.record(scopeOf(ctx), {
					actorId: ctx.memberId,
					actorLabel: ctx.actorLabel,
					action: "instance.command",
					subjectType: "instance",
					subjectId: instanceId,
					detail: { command },
				})
			})
		},

		readConsole: async (ctx: ActorContext, instanceId: string, lines: number): Promise<string> => {
			requireCapabilityFor(ctx.role, "console.read")
			const instance = await requireInstance(ctx, instanceId)

			const transport = await connectToHost(ctx, instance.hostId)
			try {
				return await readConsole(transport, instance.id, lines)
			} finally {
				await transport.close().catch(() => undefined)
			}
		},

		updateConfig: async (
			ctx: ActorContext,
			instanceId: string,
			config: InstanceConfigInput,
		): Promise<void> => {
			requireCapabilityFor(ctx.role, "config.edit")
			const instance = await requireInstance(ctx, instanceId)
			const document = renderInstanceConfig(config)

			const transport = await connectToHost(ctx, instance.hostId)
			try {
				const result = await transport.exec(
					`cat > ${shellQuote(`${deps.instancesRoot}/instances/${instance.id}/MinecraftClient.ini`)}`,
					INSTANCE_STEP_TIMEOUT_MS,
					document,
				)
				if (result.exitCode !== 0) {
					throw new Error(`Failed to write instance config: ${result.stderr.trim()}`)
				}
			} finally {
				await transport.close().catch(() => undefined)
			}

			await deps.withTransaction(async (repos) => {
				const version = await repos.instances.insertConfigVersion(
					scopeOf(ctx),
					instanceId,
					JSON.stringify(config),
					{ authorId: ctx.memberId, authorLabel: ctx.actorLabel },
				)
				await repos.audit.record(scopeOf(ctx), {
					actorId: ctx.memberId,
					actorLabel: ctx.actorLabel,
					action: "instance.config.update",
					subjectType: "instance",
					subjectId: instanceId,
					detail: { version: String(version.version) },
				})
			})
		},

		remove: async (ctx: ActorContext, instanceId: string): Promise<void> => {
			requireCapabilityFor(ctx.role, "instance.create")
			const instance = await requireInstance(ctx, instanceId)
			if (instance.authClaimId !== null && !isAuthClaimStale(instance.authClaimedAt)) {
				throw new InstanceAuthInProgressError(
					`Instance ${instanceId} is being authenticated and cannot be removed`,
				)
			}

			const transport = await connectToHost(ctx, instance.hostId)
			try {
				await transport.exec(
					`systemctl disable --now ${shellQuote(`open-mcc@${instance.id}`)} || true`,
					INSTANCE_STEP_TIMEOUT_MS,
				)
			} finally {
				await transport.close().catch(() => undefined)
			}

			await deps.withTransaction(async (repos) => {
				const removed = await repos.instances.delete(scopeOf(ctx), instanceId)
				if (!removed) {
					throw new InstanceConcurrentlyModifiedError(
						`Instance ${instanceId} changed before it could be removed`,
					)
				}
				await repos.audit.record(scopeOf(ctx), {
					actorId: ctx.memberId,
					actorLabel: ctx.actorLabel,
					action: "instance.remove",
					subjectType: "instance",
					subjectId: instanceId,
					detail: {},
				})
			})
		},
	}
}
