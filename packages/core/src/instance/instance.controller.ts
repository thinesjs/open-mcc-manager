import {
	type CreateInstanceInput,
	can,
	type InstanceConfigInput,
	minuteOfDay,
	type Role,
	type ScheduledCommandInput,
	type ScheduledCommandPublic,
	type SleepWindowInput,
	type SleepWindowPublic,
	timeOfDay,
} from "@open-mcc/contracts"
import type { Db, InstanceCommandRow, InstanceRow, InstanceScheduleRow } from "@open-mcc/db"
import type { HostTransport } from "@open-mcc/transport"
import { type AuditRepository, createAuditRepository } from "../audit/audit.repository"
import type { SecretStore } from "../crypto/sealed-box"
import type { HostRepository, OrgScope } from "../host/host.repository"
import { SYSTEMD_UNIT_DIR } from "../host/provision"
import type { SshKeyRepository } from "../ssh-key/ssh-key.repository"
import { type CommandRepository, createCommandRepository } from "./command.repository"
import { renderInstanceConfig } from "./config"
import { readConsole, sendCommand } from "./control"
import {
	createInstanceRepository,
	type InstanceRepository,
	isAuthClaimStale,
} from "./instance.repository"
import {
	expectedUnits,
	type HostReconciliation,
	reconcileHostOverTransport,
	renderScheduleUnits,
} from "./reconcile"
import {
	parseDaysOfWeek,
	renderDaysOfWeek,
	renderSleepTimers,
	sleepStartTimer,
	sleepStopTimer,
} from "./schedule"
import { createScheduleRepository, type ScheduleRepository } from "./schedule.repository"
import { SCHEDULER_ACTOR_LABEL } from "./scheduler"
import { instanceDir, instanceUser, renderEnvironmentFile, unitName } from "./unit"

export type ActorContext = {
	organizationId: string
	memberId: string
	actorLabel: string
	role: Role
}

export type InstanceTransactionRepos = {
	instances: InstanceRepository
	schedules: ScheduleRepository
	commands: CommandRepository
	audit: Pick<AuditRepository, "record">
}

export type WithInstanceTransaction = <T>(
	fn: (repos: InstanceTransactionRepos) => Promise<T>,
) => Promise<T>

export const createInstanceControllerTransaction = (db: Db): WithInstanceTransaction => {
	const withTransaction: WithInstanceTransaction = (fn) =>
		db.transaction().execute((tx) =>
			fn({
				instances: createInstanceRepository(tx),
				schedules: createScheduleRepository(tx),
				commands: createCommandRepository(tx),
				audit: createAuditRepository(tx),
			}),
		)
	return withTransaction
}

export type InstanceControllerDeps = {
	instances: InstanceRepository
	schedules: ScheduleRepository
	commands: CommandRepository
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
export class InstanceNotRunningError extends Error {}
export class InstanceHostNotFoundError extends Error {}
export class InstanceAuthInProgressError extends Error {}
export class InstanceConcurrentlyModifiedError extends Error {}

const requireCapabilityFor = (role: Role, capability: Parameters<typeof can>[1]): void => {
	if (!can(role, capability)) throw new ForbiddenError(`Role ${role} lacks ${capability}`)
}

const shellQuote = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`

export const createInstanceController = (deps: InstanceControllerDeps) => {
	const scopeOf = (ctx: ActorContext) => ({ organizationId: ctx.organizationId })

	const connectToHost = async (scope: OrgScope, hostId: string): Promise<HostTransport> => {
		const host = await deps.hosts.findById(scope, hostId)
		if (!host) throw new InstanceHostNotFoundError(`Host not found: ${hostId}`)
		if (!host.sshKeyId) throw new InstanceHostNotFoundError(`Host ${hostId} has no ssh key`)
		if (!host.hostKeyFingerprint) {
			throw new InstanceHostNotFoundError(`Host ${hostId} has no trusted host key fingerprint`)
		}
		const key = await deps.sshKeys.findById(scope, host.sshKeyId)
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

	const toScheduledCommandPublic = (row: InstanceCommandRow): ScheduledCommandPublic => ({
		id: row.id,
		instanceId: row.instanceId,
		name: row.name,
		command: row.command,
		daysOfWeek: parseDaysOfWeek(row.daysOfWeek),
		runAt: timeOfDay(row.minuteOfDay),
		timezone: row.timezone,
		enabled: row.enabled,
		lastRunAt: row.lastRunAt,
		lastRunError: row.lastRunError,
	})

	const toSleepWindowPublic = (row: InstanceScheduleRow): SleepWindowPublic => ({
		id: row.id,
		instanceId: row.instanceId,
		daysOfWeek: parseDaysOfWeek(row.daysOfWeek),
		stopAt: timeOfDay(row.stopMinuteOfDay),
		startAt: timeOfDay(row.startMinuteOfDay),
		timezone: row.timezone,
		enabled: row.enabled,
	})

	const applySleepTimers = async (
		ctx: ActorContext,
		instance: InstanceRow,
		window: SleepWindowPublic,
	): Promise<void> => {
		const timers = renderSleepTimers(window)
		const transport = await connectToHost(scopeOf(ctx), instance.hostId)
		try {
			for (const [name, unit] of Object.entries(timers)) {
				const write = await transport.exec(
					`cat > ${shellQuote(`${SYSTEMD_UNIT_DIR}/${name}`)}`,
					INSTANCE_STEP_TIMEOUT_MS,
					unit,
				)
				if (write.exitCode !== 0) {
					throw new Error(`Failed to write ${name}: ${write.stderr.trim()}`)
				}
			}
			await transport.exec("systemctl daemon-reload", INSTANCE_STEP_TIMEOUT_MS)
			for (const name of Object.keys(timers)) {
				const enable = await transport.exec(
					`systemctl enable --now ${shellQuote(name)}`,
					INSTANCE_STEP_TIMEOUT_MS,
				)
				if (enable.exitCode !== 0) {
					throw new Error(`Failed to enable ${name}: ${enable.stderr.trim()}`)
				}
			}
		} finally {
			await transport.close().catch(() => undefined)
		}
	}

	const removeSleepTimers = async (ctx: ActorContext, instance: InstanceRow): Promise<void> => {
		const names = [sleepStopTimer(instance.id), sleepStartTimer(instance.id)]
		const transport = await connectToHost(scopeOf(ctx), instance.hostId)
		try {
			for (const name of names) {
				await transport.exec(
					`systemctl disable --now ${shellQuote(name)} || true`,
					INSTANCE_STEP_TIMEOUT_MS,
				)
				await transport.exec(
					`rm -f ${shellQuote(`${SYSTEMD_UNIT_DIR}/${name}`)}`,
					INSTANCE_STEP_TIMEOUT_MS,
				)
			}
			await transport.exec("systemctl daemon-reload", INSTANCE_STEP_TIMEOUT_MS)
		} finally {
			await transport.close().catch(() => undefined)
		}
	}

	const unitCommand = async (
		ctx: ActorContext,
		instance: InstanceRow,
		verb: "start" | "stop",
	): Promise<void> => {
		const transport = await connectToHost(scopeOf(ctx), instance.hostId)
		try {
			const result = await transport.exec(
				`systemctl ${verb} ${shellQuote(unitName(instance.id))}`,
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

			const transport = await connectToHost(scopeOf(ctx), input.hostId)
			try {
				const dir = instanceDir(deps.instancesRoot, created.id)
				const steps: Array<[string, string, string | undefined]> = [
					[
						`useradd -r -U -d ${shellQuote(dir)} -s /usr/sbin/nologin ${shellQuote(instanceUser(created.id))} || true`,
						"Failed to create the instance user",
						undefined,
					],
					[
						`install -d -m 0700 -o ${shellQuote(instanceUser(created.id))} -g ${shellQuote(instanceUser(created.id))} ${shellQuote(dir)}`,
						"Failed to create the instance directory",
						undefined,
					],
					[
						`test -p ${shellQuote(`${dir}/control`)} || mkfifo -m 0600 ${shellQuote(`${dir}/control`)}`,
						"Failed to create the control fifo",
						undefined,
					],
					[
						`chown ${shellQuote(`${instanceUser(created.id)}:${instanceUser(created.id)}`)} ${shellQuote(`${dir}/control`)}`,
						"Failed to own the control fifo",
						undefined,
					],
					[
						`(umask 077; cat > ${shellQuote(`${dir}/env`)}) && chown ${shellQuote(
							`${instanceUser(created.id)}:${instanceUser(created.id)}`,
						)} ${shellQuote(`${dir}/env`)}`,
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
			if (instance.status !== "running") {
				throw new InstanceNotRunningError(
					`Instance ${instanceId} is ${instance.status}; nothing is reading its control channel`,
				)
			}

			const transport = await connectToHost(scopeOf(ctx), instance.hostId)
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

			const transport = await connectToHost(scopeOf(ctx), instance.hostId)
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

			const transport = await connectToHost(scopeOf(ctx), instance.hostId)
			try {
				const result = await transport.exec(
					`(umask 077; cat > ${shellQuote(
						`${instanceDir(deps.instancesRoot, instance.id)}/MinecraftClient.ini`,
					)}) && chown ${shellQuote(
						`${instanceUser(instance.id)}:${instanceUser(instance.id)}`,
					)} ${shellQuote(`${instanceDir(deps.instancesRoot, instance.id)}/MinecraftClient.ini`)}`,
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

		reconcileHost: async (ctx: ActorContext, hostId: string): Promise<HostReconciliation> => {
			requireCapabilityFor(ctx.role, "instance.read")

			const scope = scopeOf(ctx)
			const instances = (await deps.instances.list(scope)).filter(
				(instance) => instance.hostId === hostId,
			)
			const schedules = (await deps.schedules.list(scope)).filter((schedule) =>
				instances.some((instance) => instance.id === schedule.instanceId),
			)
			const expected = expectedUnits(instances, schedules, renderScheduleUnits)

			let transport: HostTransport
			try {
				transport = await connectToHost(scopeOf(ctx), hostId)
			} catch (error) {
				return {
					hostId,
					reachable: false,
					reason: error instanceof Error ? error.message : "Host could not be reached",
				}
			}

			try {
				return await reconcileHostOverTransport(transport, hostId, instances, expected)
			} catch (error) {
				return {
					hostId,
					reachable: false,
					reason: error instanceof Error ? error.message : "Host stopped responding",
				}
			} finally {
				await transport.close().catch(() => undefined)
			}
		},

		listScheduledCommands: async (
			ctx: ActorContext,
			instanceId: string,
		): Promise<ScheduledCommandPublic[]> => {
			requireCapabilityFor(ctx.role, "instance.read")
			await requireInstance(ctx, instanceId)
			const rows = await deps.commands.listForInstance(scopeOf(ctx), instanceId)
			return rows.map(toScheduledCommandPublic)
		},

		setScheduledCommand: async (
			ctx: ActorContext,
			input: ScheduledCommandInput,
		): Promise<ScheduledCommandPublic> => {
			requireCapabilityFor(ctx.role, "console.write")
			await requireInstance(ctx, input.instanceId)

			const row = await deps.withTransaction(async (repos) => {
				const stored = await repos.commands.upsert(scopeOf(ctx), {
					instanceId: input.instanceId,
					name: input.name,
					command: input.command,
					daysOfWeek: renderDaysOfWeek(input.daysOfWeek),
					minuteOfDay: minuteOfDay(input.runAt),
					timezone: input.timezone,
					enabled: true,
				})
				await repos.audit.record(scopeOf(ctx), {
					actorId: ctx.memberId,
					actorLabel: ctx.actorLabel,
					action: "instance.schedule",
					subjectType: "instance",
					subjectId: input.instanceId,
					detail: { schedule: input.name, command: input.command },
				})
				return stored
			})

			return toScheduledCommandPublic(row)
		},

		deleteScheduledCommand: async (ctx: ActorContext, id: string): Promise<void> => {
			requireCapabilityFor(ctx.role, "console.write")
			await deps.withTransaction(async (repos) => {
				const removed = await repos.commands.delete(scopeOf(ctx), id)
				if (!removed) return
				await repos.audit.record(scopeOf(ctx), {
					actorId: ctx.memberId,
					actorLabel: ctx.actorLabel,
					action: "instance.schedule",
					subjectType: "instance",
					subjectId: id,
					detail: { removed: "true" },
				})
			})
		},

		runScheduledCommand: async (row: InstanceCommandRow): Promise<void> => {
			const scope = { organizationId: row.organizationId }
			const instance = await deps.instances.findById(scope, row.instanceId)
			if (!instance) {
				throw new InstanceNotFoundError(`Instance not found: ${row.instanceId}`)
			}
			if (instance.status !== "running") {
				throw new InstanceNotRunningError(
					`Instance ${row.instanceId} is ${instance.status}, so its scheduled command was not sent`,
				)
			}

			const transport = await connectToHost(scope, instance.hostId)
			try {
				await sendCommand(transport, instance.id, row.command, deps.instancesRoot)
			} finally {
				await transport.close().catch(() => undefined)
			}

			await deps.withTransaction(async (repos) => {
				await repos.audit.record(scope, {
					actorId: null,
					actorLabel: SCHEDULER_ACTOR_LABEL,
					action: "instance.command",
					subjectType: "instance",
					subjectId: row.instanceId,
					detail: { command: row.command, schedule: row.name },
				})
			})
		},

		getSleepWindow: async (
			ctx: ActorContext,
			instanceId: string,
		): Promise<SleepWindowPublic | null> => {
			requireCapabilityFor(ctx.role, "instance.read")
			await requireInstance(ctx, instanceId)
			const row = await deps.schedules.findByInstance(scopeOf(ctx), instanceId)
			return row ? toSleepWindowPublic(row) : null
		},

		setSleepWindow: async (
			ctx: ActorContext,
			input: SleepWindowInput,
		): Promise<SleepWindowPublic> => {
			requireCapabilityFor(ctx.role, "instance.start")
			const instance = await requireInstance(ctx, input.instanceId)

			const stored = await deps.withTransaction(async (repos) => {
				const row = await repos.schedules.upsert(scopeOf(ctx), {
					instanceId: input.instanceId,
					daysOfWeek: renderDaysOfWeek(input.daysOfWeek),
					stopMinuteOfDay: minuteOfDay(input.stopAt),
					startMinuteOfDay: minuteOfDay(input.startAt),
					timezone: input.timezone,
					enabled: true,
				})
				await repos.audit.record(scopeOf(ctx), {
					actorId: ctx.memberId,
					actorLabel: ctx.actorLabel,
					action: "instance.schedule",
					subjectType: "instance",
					subjectId: input.instanceId,
					detail: {
						days: row.daysOfWeek,
						stop: String(row.stopMinuteOfDay),
						start: String(row.startMinuteOfDay),
						timezone: row.timezone,
					},
				})
				return row
			})

			const window = toSleepWindowPublic(stored)
			await applySleepTimers(ctx, instance, window)
			return window
		},

		clearSleepWindow: async (ctx: ActorContext, instanceId: string): Promise<void> => {
			requireCapabilityFor(ctx.role, "instance.start")
			const instance = await requireInstance(ctx, instanceId)

			await deps.withTransaction(async (repos) => {
				await repos.schedules.delete(scopeOf(ctx), instanceId)
				await repos.audit.record(scopeOf(ctx), {
					actorId: ctx.memberId,
					actorLabel: ctx.actorLabel,
					action: "instance.schedule",
					subjectType: "instance",
					subjectId: instanceId,
					detail: { cleared: "true" },
				})
			})

			await removeSleepTimers(ctx, instance)
		},

		authenticate: async (ctx: ActorContext, instanceId: string) => {
			requireCapabilityFor(ctx.role, "instance.authenticate")
			const { beginAuthentication } = await import("./authenticate")
			return await beginAuthentication(deps, ctx, instanceId)
		},

		completeAuthentication: async (ctx: ActorContext, instanceId: string) => {
			requireCapabilityFor(ctx.role, "instance.authenticate")
			const { completeAuthentication } = await import("./authenticate")
			return await completeAuthentication(deps, ctx, instanceId)
		},

		remove: async (ctx: ActorContext, instanceId: string): Promise<void> => {
			requireCapabilityFor(ctx.role, "instance.create")
			const instance = await requireInstance(ctx, instanceId)
			if (instance.authClaimId !== null && !isAuthClaimStale(instance.authClaimedAt)) {
				throw new InstanceAuthInProgressError(
					`Instance ${instanceId} is being authenticated and cannot be removed`,
				)
			}

			const transport = await connectToHost(scopeOf(ctx), instance.hostId)
			try {
				await transport.exec(
					`systemctl disable --now ${shellQuote(unitName(instance.id))} || true`,
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

export type InstanceController = ReturnType<typeof createInstanceController>
