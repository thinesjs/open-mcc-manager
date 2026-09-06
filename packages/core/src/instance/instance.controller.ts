import { randomUUID } from "node:crypto"
import {
	type CreateInstanceInput,
	can,
	type InstanceConfigInput,
	instanceConfigInput,
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
import { HostUnreachableError } from "../host/host.controller"
import type { HostRepository, OrgScope } from "../host/host.repository"
import { type HostProfile, profileFrom, systemctl, usesPerInstanceUsers } from "../host/profile"
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
import { readConsole, sendCommand } from "./control"
import {
	createInstanceRepository,
	type InstanceRepository,
	isAuthClaimStale,
} from "./instance.repository"
import {
	type LiveControlTarget,
	readChatHistory,
	readEntities,
	readInventory,
	readRecentEvents,
	readSessionStatus,
	readWorldState,
} from "./live-control"
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

export class InstanceHostNotFoundError extends Error {}
export class InstanceHostNotProvisionedError extends Error {}

type HostConnection = {
	transport: HostTransport
	profile: HostProfile
}
export class InstanceAuthInProgressError extends Error {}
export class InstanceAccountNotInteractiveError extends Error {}
export class InstanceConcurrentlyModifiedError extends Error {}

const requireCapabilityFor = (role: Role, capability: Parameters<typeof can>[1]): void => {
	if (!can(role, capability)) throw new ForbiddenError(`Role ${role} lacks ${capability}`)
}

const shellQuote = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`

export const createInstanceController = (deps: InstanceControllerDeps) => {
	const scopeOf = (ctx: ActorContext) => ({ organizationId: ctx.organizationId })

	const connectToHost = async (scope: OrgScope, hostId: string): Promise<HostConnection> => {
		const host = await deps.hosts.findById(scope, hostId)
		if (!host) throw new InstanceHostNotFoundError(`Host not found: ${hostId}`)
		if (!host.sshKeyId) throw new InstanceHostNotFoundError(`Host ${hostId} has no ssh key`)
		if (!host.hostKeyFingerprint) {
			throw new InstanceHostNotFoundError(`Host ${hostId} has no trusted host key fingerprint`)
		}
		if (!host.instancesRoot || !host.unitDir) {
			throw new InstanceHostNotProvisionedError(
				`Host ${hostId} has not finished provisioning, so its layout is unknown`,
			)
		}
		const profile = profileFrom(host.mode, host.instancesRoot, host.unitDir)
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
				error instanceof Error ? error.message : `Could not reach ${host.hostname}`,
			)
		}
		return { transport, profile }
	}

	const rotateLiveControlToken = async (
		ctx: ActorContext,
		instance: InstanceRow,
	): Promise<InstanceRow> => {
		const token = randomUUID().replaceAll("-", "")
		const sealed = deps.secrets.seal(token)
		const { transport, profile } = await connectToHost(scopeOf(ctx), instance.hostId)
		try {
			const dir = instanceDir(profile.instancesRoot, instance.id)
			const owner = instanceUser(instance.id)
			const claim = usesPerInstanceUsers(profile)
				? ` && chown ${shellQuote(`${owner}:${owner}`)} ${shellQuote(`${dir}/env`)}`
				: ""
			const result = await transport.exec(
				`(umask 077; cat > ${shellQuote(`${dir}/env`)})${claim}`,
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

	const expectedDocumentFor = async (
		scope: OrgScope,
		instance: InstanceRow,
	): Promise<string | undefined> => {
		const saved = await deps.instances.latestConfig(scope, instance.id)
		if (!saved) return undefined
		const parsed = instanceConfigInput.safeParse(saved.document)
		if (!parsed.success) return undefined
		return renderInstanceConfig({ ...parsed.data, liveControlPort: instance.liveControlPort })
	}

	const writeSavedConfig = async (ctx: ActorContext, instance: InstanceRow): Promise<void> => {
		const document = await expectedDocumentFor(scopeOf(ctx), instance)
		if (document === undefined) return

		const { transport, profile } = await connectToHost(scopeOf(ctx), instance.hostId)
		try {
			const configPath = `${instanceDir(profile.instancesRoot, instance.id)}/MinecraftClient.ini`
			const owner = instanceUser(instance.id)
			const claim = usesPerInstanceUsers(profile)
				? ` && chown ${shellQuote(`${owner}:${owner}`)} ${shellQuote(configPath)}`
				: ""
			const result = await transport.exec(
				`(umask 077; cat > ${shellQuote(configPath)})${claim}`,
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
		const config = instanceConfigInput.safeParse(saved.document)
		if (!config.success || !config.data.liveControlEnabled) return undefined

		const token = deps.secrets.open(
			instance.liveControlTokenEncrypted,
			instance.liveControlTokenKeyId,
		)
		const { transport } = await connectToHost(scopeOf(ctx), instance.hostId)
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
		const { transport, profile } = await connectToHost(scopeOf(ctx), instance.hostId)
		try {
			for (const [name, unit] of Object.entries(timers)) {
				const write = await transport.exec(
					`cat > ${shellQuote(`${profile.unitDir}/${name}`)}`,
					INSTANCE_STEP_TIMEOUT_MS,
					unit,
				)
				if (write.exitCode !== 0) {
					throw new Error(`Failed to write ${name}: ${write.stderr.trim()}`)
				}
			}
			await transport.exec(systemctl(profile, "daemon-reload"), INSTANCE_STEP_TIMEOUT_MS)
			for (const name of Object.keys(timers)) {
				const enable = await transport.exec(
					systemctl(profile, `enable --now ${shellQuote(name)}`),
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
		const { transport, profile } = await connectToHost(scopeOf(ctx), instance.hostId)
		try {
			for (const name of names) {
				await transport.exec(
					`${systemctl(profile, `disable --now ${shellQuote(name)}`)} || true`,
					INSTANCE_STEP_TIMEOUT_MS,
				)
				await transport.exec(
					`rm -f ${shellQuote(`${profile.unitDir}/${name}`)}`,
					INSTANCE_STEP_TIMEOUT_MS,
				)
			}
			await transport.exec(systemctl(profile, "daemon-reload"), INSTANCE_STEP_TIMEOUT_MS)
		} finally {
			await transport.close().catch(() => undefined)
		}
	}

	const unitCommand = async (
		ctx: ActorContext,
		instance: InstanceRow,
		verb: "start" | "stop",
	): Promise<void> => {
		const { transport, profile } = await connectToHost(scopeOf(ctx), instance.hostId)
		try {
			const result = await transport.exec(
				systemctl(profile, `${verb} ${shellQuote(unitName(instance.id))}`),
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

			const onHost = (await deps.instances.list(scopeOf(ctx))).filter(
				(instance) => instance.hostId === input.hostId,
			)
			const takenPorts = onHost.map((instance) => instance.liveControlPort)
			const { transport, profile } = await connectToHost(scopeOf(ctx), input.hostId)
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

				const dir = instanceDir(profile.instancesRoot, created.id)
				const owner = instanceUser(created.id)
				const isolated = usesPerInstanceUsers(profile)
				const own = (path: string): string =>
					isolated ? ` && chown ${shellQuote(`${owner}:${owner}`)} ${shellQuote(path)}` : ""
				const steps: Array<[string, string, string | undefined]> = []
				if (isolated) {
					steps.push([
						`useradd -r -U -d ${shellQuote(dir)} -s /usr/sbin/nologin ${shellQuote(owner)} || true`,
						"Failed to create the instance user",
						undefined,
					])
				}
				steps.push([
					isolated
						? `install -d -m 0700 -o ${shellQuote(owner)} -g ${shellQuote(owner)} ${shellQuote(dir)}`
						: `install -d -m 0700 ${shellQuote(dir)}`,
					"Failed to create the instance directory",
					undefined,
				])
				steps.push([
					`test -p ${shellQuote(`${dir}/control`)} || mkfifo -m 0600 ${shellQuote(`${dir}/control`)}`,
					"Failed to create the control fifo",
					undefined,
				])
				if (isolated) {
					steps.push([
						`chown ${shellQuote(`${owner}:${owner}`)} ${shellQuote(`${dir}/control`)}`,
						"Failed to own the control fifo",
						undefined,
					])
				}
				steps.push([
					`(umask 077; cat > ${shellQuote(`${dir}/env`)})${own(`${dir}/env`)}`,
					"Failed to write the instance environment",
					renderEnvironmentFile({ liveControlToken }),
				])
				steps.push([
					`(umask 077; cat > ${shellQuote(`${dir}/MinecraftClient.ini`)})${own(
						`${dir}/MinecraftClient.ini`,
					)}`,
					"Failed to write the instance config",
					renderInstanceConfig(initialConfig),
				])
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

			const rotated = await rotateLiveControlToken(ctx, instance)
			await writeSavedConfig(ctx, rotated)
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

			const { transport, profile } = await connectToHost(scopeOf(ctx), instance.hostId)
			try {
				await sendCommand(transport, instance.id, command, profile.instancesRoot)
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

			const { transport, profile } = await connectToHost(scopeOf(ctx), instance.hostId)
			try {
				return await readConsole(transport, instance.id, lines, profile)
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

		getConfig: async (
			ctx: ActorContext,
			instanceId: string,
		): Promise<InstanceConfigInput | undefined> => {
			requireCapabilityFor(ctx.role, "instance.read")
			const instance = await requireInstance(ctx, instanceId)
			const row = await deps.instances.latestConfig(scopeOf(ctx), instanceId)
			if (!row) return undefined
			const parsed = instanceConfigInput.safeParse(row.document)
			if (!parsed.success) return undefined
			return { ...parsed.data, liveControlPort: instance.liveControlPort }
		},

		updateConfig: async (
			ctx: ActorContext,
			instanceId: string,
			config: InstanceConfigInput,
		): Promise<void> => {
			requireCapabilityFor(ctx.role, "config.edit")
			const instance = await requireInstance(ctx, instanceId)
			const { transport, profile } = await connectToHost(scopeOf(ctx), instance.hostId)
			const settled = { ...config, liveControlPort: instance.liveControlPort }
			const document = renderInstanceConfig(settled)

			try {
				const configPath = `${instanceDir(profile.instancesRoot, instance.id)}/MinecraftClient.ini`
				const owner = instanceUser(instance.id)
				const claim = usesPerInstanceUsers(profile)
					? ` && chown ${shellQuote(`${owner}:${owner}`)} ${shellQuote(configPath)}`
					: ""
				const result = await transport.exec(
					`(umask 077; cat > ${shellQuote(configPath)})${claim}`,
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

		hostMetrics: async (ctx: ActorContext, hostId: string): Promise<HostMetrics> => {
			requireCapabilityFor(ctx.role, "instance.read")
			const { transport, profile } = await connectToHost(scopeOf(ctx), hostId)
			try {
				return await readHostMetrics(transport, profile.instancesRoot)
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
			let connection: HostConnection
			try {
				connection = await connectToHost(scopeOf(ctx), hostId)
			} catch (error) {
				return {
					hostId,
					reachable: false,
					reason: error instanceof Error ? error.message : "Host could not be reached",
				}
			}

			const { transport, profile } = connection
			const expected = expectedUnits(profile, instances, schedules, renderScheduleUnits)
			const expectedConfigs = new Map<string, string>()
			for (const instance of instances) {
				const document = await expectedDocumentFor(scope, instance)
				if (document !== undefined) expectedConfigs.set(instance.id, document)
			}

			try {
				const observed = await reconcileHostOverTransport(
					transport,
					profile,
					hostId,
					instances,
					expected,
					expectedConfigs,
				)
				for (const [id, player] of observed.seenPlayers) {
					const known = instances.find((each) => each.id === id)
					if (known && known.minecraftUsername !== player) {
						await deps.instances
							.update(scope, id, { minecraftUsername: player })
							.catch(() => undefined)
					}
				}
				return observed.reconciliation
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

			const { transport, profile } = await connectToHost(scope, instance.hostId)
			try {
				await sendCommand(transport, instance.id, row.command, profile.instancesRoot)
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

			const { transport, profile } = await connectToHost(scopeOf(ctx), instance.hostId)
			try {
				await transport.exec(
					`${systemctl(profile, `disable --now ${shellQuote(unitName(instance.id))}`)} || true`,
					INSTANCE_STEP_TIMEOUT_MS,
				)
				for (const name of [sleepStopTimer(instance.id), sleepStartTimer(instance.id)]) {
					await transport.exec(
						`${systemctl(profile, `disable --now ${shellQuote(name)}`)} || true`,
						INSTANCE_STEP_TIMEOUT_MS,
					)
					await transport.exec(
						`rm -f ${shellQuote(`${profile.unitDir}/${name}`)}`,
						INSTANCE_STEP_TIMEOUT_MS,
					)
				}
				await transport.exec(systemctl(profile, "daemon-reload"), INSTANCE_STEP_TIMEOUT_MS)
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
