import { randomUUID } from "node:crypto"
import {
	type CreateInstanceInput,
	can,
	createInstanceInput,
	type InstanceBotsInput,
	type InstanceConfigInput,
	type InstancePublic,
	type InstanceSettingsInput,
	instanceBotsInput,
	instanceConfigInput,
	instanceConfigStored,
	minuteOfDay,
	needsInteractiveSignIn,
	type Role,
	type ScheduledCommandInput,
	type ScheduledCommandPublic,
	type SleepWindowInput,
	type SleepWindowPublic,
	timeOfDay,
} from "@open-mcc/contracts"
import type {
	McpChatEntry,
	McpEntityList,
	McpEventPage,
	McpInventory,
	McpSessionStatus,
	McpWorldState,
} from "@open-mcc/contracts/boundary/mcp"
import type {
	McpLoadedBot,
	McpPlayerStats,
	McpStatusEffect,
} from "@open-mcc/contracts/boundary/mcp-readouts"
import {
	constraintViolationOf,
	type Db,
	type InstanceCommandRow,
	type InstanceRow,
	type InstanceScheduleRow,
} from "@open-mcc/db"
import { type HostTransport, LiveChannelUnavailableError } from "@open-mcc/transport"
import { type AuditRepository, createAuditRepository } from "../audit/audit.repository"
import type { SecretStore } from "../crypto/sealed-box"
import { HostMisconfiguredError, HostUnreachableError } from "../host/host.controller"
import type { HostRepository, OrgScope } from "../host/host.repository"
import { systemctl, UNIT_DIR } from "../host/profile"
import { COULD_NOT_CONNECT, connectFailureReason } from "../host/unreachable"
import type { SshKeyRepository } from "../ssh-key/ssh-key.repository"
import { type HostMetrics, readHostMetrics } from "../system/host-metrics"
import { type CommandRepository, createCommandRepository } from "./command.repository"
import {
	defaultInstanceConfig,
	freeLiveControlPorts,
	LIVE_CONTROL_ROUTE,
	LiveControlPortsExhaustedError,
	renderInstanceConfig,
} from "./config"
import { CONFIG_PATH_NAME } from "./config-drift"
import { readConsole, sendCommand } from "./control"
import {
	createInstanceRepository,
	type InstanceRepository,
	isAuthClaimStale,
} from "./instance.repository"
import {
	dropInventoryItem as dropItemOverChannel,
	type LiveControlTarget,
	readChatHistory,
	readEntities,
	readInventory,
	readLoadedBots,
	readPlayerStats,
	readPlayersList,
	readRecentEvents,
	readSessionStatus,
	readStatusEffects,
	readWorldState,
	selectHeldItem as selectItemOverChannel,
} from "./live-control"
import {
	expectedUnits,
	type HostReconciliation,
	type HostUnreachableReason,
	reconcileHostOverTransport,
	renderScheduleUnits,
} from "./reconcile"
import {
	processesGoneCommand,
	removeDirectoryCommand,
	stopUnitCommands,
	UNIT_STOP_TIMEOUT_MS,
} from "./removal"
import {
	parseDaysOfWeek,
	renderDaysOfWeek,
	renderSleepTimers,
	sleepStartTimer,
	sleepStopTimer,
} from "./schedule"
import { createScheduleRepository, type ScheduleRepository } from "./schedule.repository"
import { SCHEDULER_ACTOR_LABEL } from "./scheduler"
import { instanceDir, renderEnvironmentFile, unitName } from "./unit"

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
	withTransaction: WithInstanceTransaction
}

export const LIVE_PORT_PROBE_TIMEOUT_MS = 3_000

export const LIVE_PORT_CLAIM_ATTEMPTS = 5

export const LIVE_PORT_CONSTRAINT = "instance_live_control_port_unique"

export const INSTANCE_STEP_TIMEOUT_MS = 15_000
const CONNECT_TIMEOUT_MS = 10_000

export class ForbiddenError extends Error {}
export class InstanceNotFoundError extends Error {}
export class InstanceNotRunningError extends Error {}
export { HostUnreachableError }

export class InstanceConfigUnusableError extends Error {}

export class InstanceBotConfigUnusableError extends Error {}
export class InstanceHostNotFoundError extends Error {}
export class InstanceHostNotProvisionedError extends Error {}

export const scheduledRunFailure = (error: Error | string): string => {
	if (error instanceof HostUnreachableError) return error.message
	if (error instanceof InstanceNotRunningError) return "The bot was not running"
	if (error instanceof InstanceNotFoundError) return "The bot no longer exists"
	if (
		error instanceof InstanceHostNotFoundError ||
		error instanceof InstanceHostNotProvisionedError
	) {
		return "Its host is not set up to run bots"
	}
	return "The command could not be sent"
}

export class InstanceAuthInProgressError extends Error {}
export class InstanceAccountNotInteractiveError extends Error {}
export class InstanceConcurrentlyModifiedError extends Error {}
export class InstanceStillInUseError extends Error {}
export class InstanceRemovalFailedError extends Error {}

const requireCapabilityFor = (role: Role, capability: Parameters<typeof can>[1]): void => {
	if (!can(role, capability)) throw new ForbiddenError(`Role ${role} lacks ${capability}`)
}

const reasonFor = (error: Error): HostUnreachableReason => {
	if (error instanceof InstanceHostNotProvisionedError) return "unprovisioned"
	if (error instanceof InstanceHostNotFoundError) return "misconfigured"
	if (error instanceof HostUnreachableError) return "unreachable"
	return "failed"
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
		if (host.status !== "ready") {
			throw new InstanceHostNotProvisionedError(`Host ${hostId} has not finished provisioning`)
		}
		const key = await deps.sshKeys.findById(scope, host.sshKeyId)
		if (!key) throw new InstanceHostNotFoundError(`Ssh key not found for host ${hostId}`)

		const transport = deps.createTransport()
		try {
			await transport.connect({
				hostname: host.hostname,
				port: host.port,
				username: host.username,
				privateKey: deps.secrets.open(key.privateKeyEncrypted, key.privateKeyKeyId),
				expectedFingerprint: host.hostKeyFingerprint,
				timeoutMs: CONNECT_TIMEOUT_MS,
			})
		} catch (error) {
			await transport.close().catch(() => undefined)
			throw new HostUnreachableError(
				error instanceof Error ? connectFailureReason(error) : COULD_NOT_CONNECT,
			)
		}
		return transport
	}

	const rotateLiveControlToken = async (
		ctx: ActorContext,
		instance: InstanceRow,
	): Promise<InstanceRow> => {
		const token = randomUUID().replaceAll("-", "")
		const sealed = deps.secrets.seal(token)
		const transport = await connectToHost(scopeOf(ctx), instance.hostId)
		try {
			const result = await transport.exec(
				`(umask 077; cat > ${instanceDir(instance.id)}/env)`,
				INSTANCE_STEP_TIMEOUT_MS,
				renderEnvironmentFile({ liveControlToken: token }),
			)
			if (result.exitCode !== 0) {
				throw new Error(`Failed to write the instance environment: ${result.stderr.trim()}`)
			}
		} finally {
			await transport.close().catch(() => undefined)
		}

		const updated = await deps.instances.update(scopeOf(ctx), instance.id, {
			liveControlTokenEncrypted: sealed.ciphertext,
			liveControlTokenKeyId: sealed.keyId,
		})
		return updated ?? instance
	}

	const insertWithFreePort = async (attempt: () => Promise<InstanceRow>): Promise<InstanceRow> => {
		for (let tries = 0; tries < LIVE_PORT_CLAIM_ATTEMPTS; tries += 1) {
			try {
				return await attempt()
			} catch (error) {
				const violation = error instanceof Error ? constraintViolationOf(error) : null
				if (violation?.constraint !== LIVE_PORT_CONSTRAINT) throw error
			}
		}
		throw new LiveControlPortsExhaustedError(
			"Another instance claimed every port this one tried on that host",
		)
	}

	const unusedPortOnHost = async (
		transport: HostTransport,
		taken: readonly number[],
	): Promise<number> => {
		for (const port of freeLiveControlPorts(taken)) {
			if (!(await transport.canForward(port, LIVE_PORT_PROBE_TIMEOUT_MS))) return port
		}
		throw new LiveControlPortsExhaustedError(
			"No live control port on this host is both unrecorded and unused",
		)
	}

	const storedConfigFor = async (
		scope: OrgScope,
		instance: InstanceRow,
	): Promise<InstanceConfigInput | undefined> => {
		const saved = await deps.instances.latestConfig(scope, instance.id)
		if (!saved) return undefined
		const parsed = instanceConfigStored.safeParse(saved.document)
		if (!parsed.success) {
			throw new InstanceConfigUnusableError(
				`Saved settings for instance ${instance.id} are unusable`,
			)
		}
		return { ...parsed.data, liveControlPort: instance.liveControlPort }
	}

	const usableBots = (instanceId: string, stored: InstanceBotsInput): InstanceBotsInput => {
		const bots = instanceBotsInput.safeParse({
			botConfig: stored.botConfig,
			advancedKeys: stored.advancedKeys,
		})
		if (!bots.success) {
			throw new InstanceBotConfigUnusableError(
				`Saved bot settings for instance ${instanceId} are unusable`,
			)
		}
		return bots.data
	}

	const expectedDocumentFor = async (
		scope: OrgScope,
		instance: InstanceRow,
	): Promise<string | undefined> => {
		const stored = await storedConfigFor(scope, instance)
		if (stored === undefined) return undefined
		usableBots(instance.id, stored)
		const usable = instanceConfigInput.safeParse(stored)
		if (!usable.success) {
			throw new InstanceConfigUnusableError(
				`Saved settings for instance ${instance.id} are unusable`,
			)
		}
		return renderInstanceConfig(usable.data)
	}

	const savedBots = async (ctx: ActorContext, instanceId: string): Promise<InstanceBotsInput> => {
		const row = await deps.instances.latestConfig(scopeOf(ctx), instanceId)
		if (!row) return { botConfig: {}, advancedKeys: {} }
		const parsed = instanceConfigStored.safeParse(row.document)
		if (!parsed.success) {
			throw new InstanceConfigUnusableError(
				`Saved settings for instance ${instanceId} are unusable`,
			)
		}
		return usableBots(instanceId, parsed.data)
	}

	const writeConfigDocument = async (
		ctx: ActorContext,
		instance: InstanceRow,
		document: string | undefined,
	): Promise<void> => {
		if (document === undefined) return

		const transport = await connectToHost(scopeOf(ctx), instance.hostId)
		try {
			const configPath = `${instanceDir(instance.id)}/MinecraftClient.ini`
			const result = await transport.exec(
				`(umask 077; cat > ${configPath})`,
				INSTANCE_STEP_TIMEOUT_MS,
				document,
			)
			if (result.exitCode !== 0) {
				throw new Error(`Failed to write instance config: ${result.stderr.trim()}`)
			}
		} finally {
			await transport.close().catch(() => undefined)
		}
	}

	const liveControlTargetFor = async (
		ctx: ActorContext,
		instanceId: string,
	): Promise<{ target: LiveControlTarget; close: () => Promise<void> } | undefined> => {
		const instance = await requireInstance(ctx, instanceId)
		if (!instance.liveControlTokenEncrypted || !instance.liveControlTokenKeyId) return undefined
		const saved = await deps.instances.latestConfig(scopeOf(ctx), instanceId)
		if (!saved) return undefined
		const config = instanceConfigStored.safeParse(saved.document)
		if (!config.success || !config.data.liveControlEnabled) return undefined

		const token = deps.secrets.open(
			instance.liveControlTokenEncrypted,
			instance.liveControlTokenKeyId,
		)
		const transport = await connectToHost(scopeOf(ctx), instance.hostId)
		return {
			target: {
				transport,
				port: instance.liveControlPort,
				route: LIVE_CONTROL_ROUTE,
				token,
			},
			close: async () => {
				await transport.close().catch(() => undefined)
			},
		}
	}

	const requireInstance = async (ctx: ActorContext, instanceId: string): Promise<InstanceRow> => {
		const found = await deps.instances.findById(scopeOf(ctx), instanceId)
		if (!found) throw new InstanceNotFoundError(`Instance not found: ${instanceId}`)
		return found
	}

	const toInstancePublic = (row: InstanceRow): InstancePublic => ({
		id: row.id,
		hostId: row.hostId,
		name: row.name,
		accountType: row.accountType,
		minecraftAccount: row.minecraftAccount,
		minecraftUsername: row.minecraftUsername,
		status: row.status,
		lastExitCode: row.lastExitCode,
		createdAt: row.createdAt.toISOString(),
	})

	const toScheduledCommandPublic = (row: InstanceCommandRow): ScheduledCommandPublic => ({
		id: row.id,
		instanceId: row.instanceId,
		name: row.name,
		command: row.command,
		daysOfWeek: parseDaysOfWeek(row.daysOfWeek),
		runAt: timeOfDay(row.minuteOfDay),
		timezone: row.timezone,
		enabled: row.enabled,
		lastRunAt: row.lastRunAt?.toISOString() ?? null,
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
		window: SleepWindowInput,
	): Promise<void> => {
		const timers = renderSleepTimers(window)
		const transport = await connectToHost(scopeOf(ctx), instance.hostId)
		try {
			for (const [name, unit] of Object.entries(timers)) {
				const write = await transport.exec(
					`cat > ${UNIT_DIR}/${shellQuote(name)}`,
					INSTANCE_STEP_TIMEOUT_MS,
					unit,
				)
				if (write.exitCode !== 0) {
					throw new HostMisconfiguredError(`Failed to write ${name}: ${write.stderr.trim()}`)
				}
			}
			await transport.exec(systemctl("daemon-reload"), INSTANCE_STEP_TIMEOUT_MS)
			for (const name of Object.keys(timers)) {
				const enable = await transport.exec(
					systemctl(`enable --now ${shellQuote(name)}`),
					INSTANCE_STEP_TIMEOUT_MS,
				)
				if (enable.exitCode !== 0) {
					throw new HostMisconfiguredError(`Failed to enable ${name}: ${enable.stderr.trim()}`)
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
					`${systemctl(`disable --now ${shellQuote(name)}`)} || true`,
					INSTANCE_STEP_TIMEOUT_MS,
				)
				await transport.exec(`rm -f ${UNIT_DIR}/${shellQuote(name)}`, INSTANCE_STEP_TIMEOUT_MS)
			}
			await transport.exec(systemctl("daemon-reload"), INSTANCE_STEP_TIMEOUT_MS)
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
				systemctl(`${verb} ${shellQuote(unitName(instance.id))}`),
				verb === "stop" ? UNIT_STOP_TIMEOUT_MS : INSTANCE_STEP_TIMEOUT_MS,
			)
			if (result.exitCode !== 0) {
				throw new Error(`Failed to ${verb} instance ${instance.id}: ${result.stderr.trim()}`)
			}
		} finally {
			await transport.close().catch(() => undefined)
		}
	}

	const controller = {
		list: async (ctx: ActorContext): Promise<InstancePublic[]> => {
			requireCapabilityFor(ctx.role, "instance.read")
			return (await deps.instances.list(scopeOf(ctx))).map(toInstancePublic)
		},

		get: async (ctx: ActorContext, instanceId: string): Promise<InstancePublic> => {
			requireCapabilityFor(ctx.role, "instance.read")
			return toInstancePublic(await requireInstance(ctx, instanceId))
		},

		create: async (ctx: ActorContext, given: CreateInstanceInput): Promise<InstancePublic> => {
			requireCapabilityFor(ctx.role, "instance.create")
			const input = createInstanceInput.parse(given)
			const host = await deps.hosts.findById(scopeOf(ctx), input.hostId)
			if (!host) throw new InstanceHostNotFoundError(`Host not found: ${input.hostId}`)

			const onHost = (await deps.instances.list(scopeOf(ctx))).filter(
				(instance) => instance.hostId === input.hostId,
			)
			const takenPorts = onHost.map((instance) => instance.liveControlPort)
			const transport = await connectToHost(scopeOf(ctx), input.hostId)
			let created: InstanceRow
			try {
				const liveControlToken = randomUUID().replaceAll("-", "")
				const sealedToken = deps.secrets.seal(liveControlToken)
				const claimed: number[] = [...takenPorts]
				let initialConfig = defaultInstanceConfig({
					accountType: input.accountType,
					minecraftAccount: input.minecraftAccount,
					serverAddress: input.serverAddress,
				})

				created = await insertWithFreePort(async () => {
					const port = await unusedPortOnHost(transport, claimed)
					claimed.push(port)
					initialConfig = { ...initialConfig, liveControlPort: port }
					return await deps.withTransaction(async (repos) => {
						const row = await repos.instances.insert(scopeOf(ctx), {
							hostId: input.hostId,
							name: input.name,
							accountType: input.accountType,
							minecraftAccount: input.minecraftAccount,
							status: needsInteractiveSignIn(input.accountType) ? "needs_auth" : "stopped",
							liveControlPort: port,
							liveControlTokenEncrypted: sealedToken.ciphertext,
							liveControlTokenKeyId: sealedToken.keyId,
						})
						await repos.instances.insertConfigVersion(
							scopeOf(ctx),
							row.id,
							JSON.stringify(initialConfig),
							{ authorId: ctx.memberId, authorLabel: ctx.actorLabel },
						)
						await repos.audit.record(scopeOf(ctx), {
							actorId: ctx.memberId,
							actorLabel: ctx.actorLabel,
							action: "instance.create",
							subjectType: "instance",
							subjectId: row.id,
							detail: {
								hostId: input.hostId,
								name: input.name,
								accountType: input.accountType,
							},
						})
						return row
					})
				})

				const dir = instanceDir(created.id)
				const steps: Array<[string, string, string | undefined]> = [
					[`install -d -m 0700 ${dir}`, "Failed to create the instance directory", undefined],
					[
						`test -p ${dir}/control || mkfifo -m 0600 ${dir}/control`,
						"Failed to create the control fifo",
						undefined,
					],
					[
						`(umask 077; cat > ${dir}/env)`,
						"Failed to write the instance environment",
						renderEnvironmentFile({ liveControlToken }),
					],
					[
						`(umask 077; cat > ${dir}/MinecraftClient.ini)`,
						"Failed to write the instance config",
						renderInstanceConfig(initialConfig),
					],
				]
				for (const [command, failure, stdin] of steps) {
					const result = await transport.exec(command, INSTANCE_STEP_TIMEOUT_MS, stdin)
					if (result.exitCode !== 0) throw new Error(`${failure}: ${result.stderr.trim()}`)
				}
			} finally {
				await transport.close().catch(() => undefined)
			}

			return toInstancePublic(created)
		},

		start: async (ctx: ActorContext, instanceId: string): Promise<InstancePublic> => {
			requireCapabilityFor(ctx.role, "instance.start")
			const instance = await requireInstance(ctx, instanceId)
			if (instance.status === "needs_auth") {
				throw new InstanceAuthInProgressError(
					`Instance ${instanceId} has not completed its microsoft sign-in`,
				)
			}

			const document = await expectedDocumentFor(scopeOf(ctx), instance)
			const rotated = await rotateLiveControlToken(ctx, instance)
			await writeConfigDocument(ctx, rotated, document)
			await unitCommand(ctx, rotated, "start")

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
			return toInstancePublic(updated)
		},

		restart: async (ctx: ActorContext, instanceId: string): Promise<InstancePublic> => {
			requireCapabilityFor(ctx.role, "instance.start")
			const instance = await requireInstance(ctx, instanceId)
			if (instance.status === "needs_auth") {
				throw new InstanceAuthInProgressError(
					`Instance ${instanceId} has not completed its microsoft sign-in`,
				)
			}

			const document = await expectedDocumentFor(scopeOf(ctx), instance)
			await unitCommand(ctx, instance, "stop")
			const rotated = await rotateLiveControlToken(ctx, instance)
			await writeConfigDocument(ctx, rotated, document)
			await unitCommand(ctx, rotated, "start")

			const restarted = await deps.withTransaction(async (repos) => {
				const row = await repos.instances.update(scopeOf(ctx), instanceId, { status: "running" })
				if (!row) {
					throw new InstanceConcurrentlyModifiedError(
						`Instance ${instanceId} changed before it could be restarted`,
					)
				}
				await repos.audit.record(scopeOf(ctx), {
					actorId: ctx.memberId,
					actorLabel: ctx.actorLabel,
					action: "instance.restart",
					subjectType: "instance",
					subjectId: instanceId,
					detail: {},
				})
				return row
			})
			return toInstancePublic(restarted)
		},

		stop: async (ctx: ActorContext, instanceId: string): Promise<InstancePublic> => {
			requireCapabilityFor(ctx.role, "instance.start")
			const instance = await requireInstance(ctx, instanceId)

			await unitCommand(ctx, instance, "stop")

			const stopped = await deps.withTransaction(async (repos) => {
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
			return toInstancePublic(stopped)
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
				await sendCommand(transport, instance.id, command)
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

		readLiveStatus: async (
			ctx: ActorContext,
			instanceId: string,
		): Promise<McpSessionStatus | undefined> => {
			requireCapabilityFor(ctx.role, "instance.read")
			const target = await liveControlTargetFor(ctx, instanceId)
			if (!target) return undefined
			try {
				return await readSessionStatus(target.target)
			} catch (error) {
				if (error instanceof LiveChannelUnavailableError) return undefined
				throw error
			} finally {
				await target.close()
			}
		},

		readLiveChat: async (
			ctx: ActorContext,
			instanceId: string,
		): Promise<McpChatEntry[] | undefined> => {
			requireCapabilityFor(ctx.role, "console.read")
			const target = await liveControlTargetFor(ctx, instanceId)
			if (!target) return undefined
			try {
				return await readChatHistory(target.target)
			} catch (error) {
				if (error instanceof LiveChannelUnavailableError) return undefined
				throw error
			} finally {
				await target.close()
			}
		},

		readLiveEvents: async (
			ctx: ActorContext,
			instanceId: string,
		): Promise<McpEventPage | undefined> => {
			requireCapabilityFor(ctx.role, "console.read")
			const target = await liveControlTargetFor(ctx, instanceId)
			if (!target) return undefined
			try {
				return await readRecentEvents(target.target)
			} catch (error) {
				if (error instanceof LiveChannelUnavailableError) return undefined
				throw error
			} finally {
				await target.close()
			}
		},

		readLiveWorld: async (
			ctx: ActorContext,
			instanceId: string,
		): Promise<McpWorldState | undefined> => {
			requireCapabilityFor(ctx.role, "instance.read")
			const target = await liveControlTargetFor(ctx, instanceId)
			if (!target) return undefined
			try {
				return await readWorldState(target.target)
			} catch (error) {
				if (error instanceof LiveChannelUnavailableError) return undefined
				throw error
			} finally {
				await target.close()
			}
		},

		readLiveEntities: async (
			ctx: ActorContext,
			instanceId: string,
		): Promise<McpEntityList | undefined> => {
			requireCapabilityFor(ctx.role, "instance.read")
			const target = await liveControlTargetFor(ctx, instanceId)
			if (!target) return undefined
			try {
				return await readEntities(target.target)
			} catch (error) {
				if (error instanceof LiveChannelUnavailableError) return undefined
				throw error
			} finally {
				await target.close()
			}
		},

		readLiveInventory: async (
			ctx: ActorContext,
			instanceId: string,
		): Promise<McpInventory | undefined> => {
			requireCapabilityFor(ctx.role, "instance.read")
			const target = await liveControlTargetFor(ctx, instanceId)
			if (!target) return undefined
			try {
				return await readInventory(target.target)
			} catch (error) {
				if (error instanceof LiveChannelUnavailableError) return undefined
				throw error
			} finally {
				await target.close()
			}
		},

		readLivePlayerStats: async (
			ctx: ActorContext,
			instanceId: string,
		): Promise<McpPlayerStats | undefined> => {
			requireCapabilityFor(ctx.role, "instance.read")
			const target = await liveControlTargetFor(ctx, instanceId)
			if (!target) return undefined
			try {
				return await readPlayerStats(target.target)
			} catch (error) {
				if (error instanceof LiveChannelUnavailableError) return undefined
				throw error
			} finally {
				await target.close()
			}
		},

		readLiveStatusEffects: async (
			ctx: ActorContext,
			instanceId: string,
		): Promise<McpStatusEffect[] | undefined> => {
			requireCapabilityFor(ctx.role, "instance.read")
			const target = await liveControlTargetFor(ctx, instanceId)
			if (!target) return undefined
			try {
				return await readStatusEffects(target.target)
			} catch (error) {
				if (error instanceof LiveChannelUnavailableError) return undefined
				throw error
			} finally {
				await target.close()
			}
		},

		readLiveBots: async (
			ctx: ActorContext,
			instanceId: string,
		): Promise<McpLoadedBot[] | undefined> => {
			requireCapabilityFor(ctx.role, "instance.read")
			const target = await liveControlTargetFor(ctx, instanceId)
			if (!target) return undefined
			try {
				return await readLoadedBots(target.target)
			} catch (error) {
				if (error instanceof LiveChannelUnavailableError) return undefined
				throw error
			} finally {
				await target.close()
			}
		},

		readLivePlayers: async (
			ctx: ActorContext,
			instanceId: string,
		): Promise<string[] | undefined> => {
			requireCapabilityFor(ctx.role, "instance.read")
			const target = await liveControlTargetFor(ctx, instanceId)
			if (!target) return undefined
			try {
				return await readPlayersList(target.target)
			} catch (error) {
				if (error instanceof LiveChannelUnavailableError) return undefined
				throw error
			} finally {
				await target.close()
			}
		},

		dropInventoryItem: async (
			ctx: ActorContext,
			instanceId: string,
			itemType: string,
			count: number,
		): Promise<void> => {
			requireCapabilityFor(ctx.role, "console.write")
			const target = await liveControlTargetFor(ctx, instanceId)
			if (!target) throw new LiveChannelUnavailableError("Live view is not open for this instance")
			try {
				await dropItemOverChannel(target.target, itemType, count)
			} finally {
				await target.close()
			}
			await deps.withTransaction(async (repos) => {
				await repos.audit.record(scopeOf(ctx), {
					actorId: ctx.memberId,
					actorLabel: ctx.actorLabel,
					action: "instance.inventory.drop",
					subjectType: "instance",
					subjectId: instanceId,
					detail: { itemType, count: String(count) },
				})
			})
		},

		selectHeldItem: async (
			ctx: ActorContext,
			instanceId: string,
			itemType: string,
		): Promise<void> => {
			requireCapabilityFor(ctx.role, "console.write")
			const target = await liveControlTargetFor(ctx, instanceId)
			if (!target) throw new LiveChannelUnavailableError("Live view is not open for this instance")
			try {
				await selectItemOverChannel(target.target, itemType)
			} finally {
				await target.close()
			}
			await deps.withTransaction(async (repos) => {
				await repos.audit.record(scopeOf(ctx), {
					actorId: ctx.memberId,
					actorLabel: ctx.actorLabel,
					action: "instance.inventory.select",
					subjectType: "instance",
					subjectId: instanceId,
					detail: { itemType },
				})
			})
		},

		getConfig: async (
			ctx: ActorContext,
			instanceId: string,
		): Promise<InstanceConfigInput | undefined> => {
			requireCapabilityFor(ctx.role, "instance.read")
			const instance = await requireInstance(ctx, instanceId)
			const row = await deps.instances.latestConfig(scopeOf(ctx), instanceId)
			if (!row) return undefined
			const parsed = instanceConfigStored.safeParse(row.document)
			if (!parsed.success) return undefined
			return { ...parsed.data, liveControlPort: instance.liveControlPort }
		},

		updateConfig: async (
			ctx: ActorContext,
			instanceId: string,
			config: InstanceConfigInput,
		): Promise<void> => {
			requireCapabilityFor(ctx.role, "config.edit")
			const checked = instanceConfigInput.parse(config)
			const instance = await requireInstance(ctx, instanceId)
			const transport = await connectToHost(scopeOf(ctx), instance.hostId)
			const settled = { ...checked, liveControlPort: instance.liveControlPort }
			const document = renderInstanceConfig(settled)

			try {
				const configPath = `${instanceDir(instance.id)}/MinecraftClient.ini`
				const result = await transport.exec(
					`(umask 077; cat > ${configPath})`,
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
					JSON.stringify(settled),
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

		updateSettings: async (
			ctx: ActorContext,
			instanceId: string,
			settings: InstanceSettingsInput,
		): Promise<void> => {
			requireCapabilityFor(ctx.role, "config.edit")
			await requireInstance(ctx, instanceId)
			await controller.updateConfig(ctx, instanceId, {
				...settings,
				...(await savedBots(ctx, instanceId)),
			})
		},

		updateBotConfig: async (
			ctx: ActorContext,
			instanceId: string,
			bots: InstanceBotsInput,
		): Promise<void> => {
			requireCapabilityFor(ctx.role, "config.edit")
			const saved = await controller.getConfig(ctx, instanceId)
			if (!saved) throw new Error(`No saved settings for instance ${instanceId}`)
			await controller.updateConfig(ctx, instanceId, { ...saved, ...bots })
		},

		hostMetrics: async (ctx: ActorContext, hostId: string): Promise<HostMetrics> => {
			requireCapabilityFor(ctx.role, "instance.read")
			const transport = await connectToHost(scopeOf(ctx), hostId)
			try {
				return await readHostMetrics(transport)
			} finally {
				await transport.close().catch(() => undefined)
			}
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
			let transport: HostTransport
			try {
				transport = await connectToHost(scopeOf(ctx), hostId)
			} catch (error) {
				const reason = error instanceof Error ? reasonFor(error) : "failed"
				return { hostId, reachable: false, reason }
			}

			const expected = expectedUnits(instances, schedules, renderScheduleUnits)

			try {
				const expectedConfigs = new Map<string, string>()
				const unusable: string[] = []
				for (const instance of instances) {
					try {
						const stored = await storedConfigFor(scope, instance)
						if (stored !== undefined) expectedConfigs.set(instance.id, renderInstanceConfig(stored))
					} catch (error) {
						if (!(error instanceof InstanceConfigUnusableError)) throw error
						unusable.push(instance.id)
					}
				}

				let observed: Awaited<ReturnType<typeof reconcileHostOverTransport>>
				try {
					observed = await reconcileHostOverTransport(
						transport,
						hostId,
						instances,
						expected,
						expectedConfigs,
					)
				} catch {
					return { hostId, reachable: false, reason: "interrupted" }
				}
				for (const [id, player] of observed.seenPlayers) {
					const known = instances.find((each) => each.id === id)
					if (known && known.minecraftUsername !== player) {
						await deps.instances
							.update(scope, id, { minecraftUsername: player })
							.catch(() => undefined)
					}
				}
				const reconciliation = observed.reconciliation
				if (!reconciliation.reachable || unusable.length === 0) return reconciliation
				return {
					...reconciliation,
					configDrift: [
						...reconciliation.configDrift,
						...unusable.map((instanceId) => ({
							instanceId,
							kind: "unreadable" as const,
							key: CONFIG_PATH_NAME,
							expected: null,
							actual: null,
						})),
					],
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
					enabled: input.enabled,
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
				const removed = await repos.commands.deleteReturning(scopeOf(ctx), id)
				if (!removed) return
				await repos.audit.record(scopeOf(ctx), {
					actorId: ctx.memberId,
					actorLabel: ctx.actorLabel,
					action: "instance.schedule",
					subjectType: "instance",
					subjectId: removed.instanceId,
					detail: {
						removed: "true",
						schedule: removed.name,
						command: removed.command,
						scheduleId: removed.id,
					},
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
				await sendCommand(transport, instance.id, row.command)
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

			try {
				await applySleepTimers(ctx, instance, input)
			} catch (error) {
				if (!(error instanceof HostUnreachableError)) {
					await deps.schedules
						.findByInstance(scopeOf(ctx), input.instanceId)
						.then((current) =>
							current
								? applySleepTimers(ctx, instance, toSleepWindowPublic(current))
								: removeSleepTimers(ctx, instance),
						)
						.catch(() => undefined)
				}
				throw error
			}

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

			return toSleepWindowPublic(stored)
		},

		clearSleepWindow: async (ctx: ActorContext, instanceId: string): Promise<void> => {
			requireCapabilityFor(ctx.role, "instance.start")
			const instance = await requireInstance(ctx, instanceId)

			await removeSleepTimers(ctx, instance)

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

		cancelAuthentication: async (ctx: ActorContext, instanceId: string) => {
			requireCapabilityFor(ctx.role, "instance.authenticate")
			const { cancelAuthentication } = await import("./authenticate")
			return await cancelAuthentication(deps, ctx, instanceId)
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
				for (const name of [sleepStopTimer(instance.id), sleepStartTimer(instance.id)]) {
					await transport.exec(
						`${systemctl(`disable --now ${shellQuote(name)}`)} || true`,
						INSTANCE_STEP_TIMEOUT_MS,
					)
					await transport.exec(`rm -f ${UNIT_DIR}/${shellQuote(name)}`, INSTANCE_STEP_TIMEOUT_MS)
				}
				await transport.exec(systemctl("daemon-reload"), INSTANCE_STEP_TIMEOUT_MS)
				const stopUnits = async () => {
					for (const command of stopUnitCommands(instance.id)) {
						await transport.exec(command, UNIT_STOP_TIMEOUT_MS)
					}
				}
				const unfinished = () =>
					new InstanceRemovalFailedError(
						`Instance ${instanceId} could not be fully removed from its host`,
					)

				await stopUnits()
				const quiet = await transport.exec(
					processesGoneCommand(instance.id),
					INSTANCE_STEP_TIMEOUT_MS,
				)
				if (quiet.exitCode !== 0) {
					throw new InstanceStillInUseError(`Instance ${instanceId} is still in use on its host`)
				}

				const directory = await transport.exec(
					removeDirectoryCommand(instance.id),
					INSTANCE_STEP_TIMEOUT_MS,
				)
				if (directory.exitCode !== 0) throw unfinished()

				await stopUnits()
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

	return controller
}

export type InstanceController = ReturnType<typeof createInstanceController>
