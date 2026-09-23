import { randomUUID } from "node:crypto"
import {
	type CreateInstanceInput,
	can,
	createInstanceInput,
	type InstanceBotsInput,
	type InstanceConfigInput,
	type InstanceConfigStored,
	type InstanceConfigView,
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
	type InstanceConfigRow,
	type InstanceRow,
	type InstanceScheduleRow,
} from "@open-mcc/db"
import {
	ChannelLimitReachedError,
	type ConnectionIdentity,
	type ConnectOptions,
	type ExecResult,
	type HostReader,
	type HostTransport,
	LiveChannelUnavailableError,
	type ReadConnections,
	readCommandText,
	TransportInterruptedError,
} from "@open-mcc/transport"
import { type AuditRepository, createAuditRepository } from "../audit/audit.repository"
import type { SecretStore } from "../crypto/sealed-box"
import { endedByDeadline } from "../host/deadline"
import { HostMisconfiguredError, HostUnreachableError } from "../host/host.controller"
import { createHostRepository, type HostRepository, type OrgScope } from "../host/host.repository"
import { type HostReadLease, leaseHostReader } from "../host/host-reader"
import { systemctl, UNIT_DIR } from "../host/profile"
import { checkHostRuntime, type HostNeed, hostMeets } from "../host/runtime-guard"
import { COULD_NOT_CONNECT, connectFailureReason } from "../host/unreachable"
import { HostRefusedError, InternalError } from "../lib/errors"
import { assertExhaustive } from "../lib/exhaustive"
import { redactCommand } from "../security/redact"
import type { SshKeyRepository } from "../ssh-key/ssh-key.repository"
import { HOST_METRICS_TIMEOUT_MS, type HostMetrics, readHostMetrics } from "../system/host-metrics"
import { type CommandRepository, createCommandRepository } from "./command.repository"
import {
	defaultInstanceConfig,
	freeLiveControlPorts,
	LIVE_CONTROL_ROUTE,
	LiveControlPortsExhaustedError,
	renderInstanceConfig,
} from "./config"
import { CONFIG_PATH_NAME } from "./config-drift"
import { CONSOLE_READ_DEADLINE_MS, readConsole } from "./console"
import { refuseStoredCredential, sendableLine, sendCommand } from "./control"
import {
	createInstanceRepository,
	type InstanceRepository,
	isAuthClaimStale,
} from "./instance.repository"
import {
	dropInventoryItem as dropItemOverChannel,
	LIVE_CONTROL_TIMEOUT_MS,
	type LiveControlTarget,
	type LiveReadTarget,
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
	activeCheckCommand,
	expectedUnits,
	type HostReconciliation,
	type HostUnreachableReason,
	RECONCILE_DEADLINE_MS,
	reconcileHostOverTransport,
	renderScheduleUnits,
	unitRuntimeFor,
} from "./reconcile"
import {
	DIRECTORY_DELETE_TIMEOUT_MS,
	deleteDirectoryCommand,
	REMOVAL_STEP_TIMEOUT_MS,
	removeContainersCommand,
	removeTimersCommand,
	stopUnitsCommand,
	UNIT_STOP_TIMEOUT_MS,
	verifyGoneCommand,
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
import {
	configWriteCommand,
	ENV_WRITTEN,
	envWriteUnlessRunningCommand,
	HostAnswerUnreadableError,
	instanceLayoutSteps,
	parseEnvWriteAnswer,
	parseUnitStartState,
	RUNNING_UNIT_STATES,
	renderEnvironmentFile,
	startUnitCommand,
	UNIT_START_TIMEOUT_MS,
	unitName,
} from "./unit"

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
	hosts: Pick<HostRepository, "lockHost" | "findById">
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
				hosts: createHostRepository(tx),
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
	readConnections: Pick<ReadConnections, "lease">
	withTransaction: WithInstanceTransaction
	now: () => number
}

export const ACTIVE_RESULT_MAX_AGE_MS = 5_000

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
export class InstanceSignInRunningError extends Error {}
export class InstanceSignInDidNotStartError extends Error {}
export class InstanceSignInNoDeviceCodeError extends Error {}
export class InstanceSignInOtherAccountError extends Error {}
export class InstanceAccountNotInteractiveError extends Error {}
export class InstanceConcurrentlyModifiedError extends Error {}
export class InstanceBusyError extends Error {}
export class InstanceStillInUseError extends Error {}
export class InstanceRemovalFailedError extends Error {}
export class InstanceStartFailedError extends Error {}
export class InstanceStopFailedError extends Error {}
export class InstanceCommandNotSentError extends Error {}
export class InstanceConsoleUnreadableError extends Error {}

const failingAs = async <T>(
	Failure: new (message: string) => Error,
	work: () => Promise<T>,
): Promise<T> => {
	try {
		return await work()
	} catch (error) {
		if (!(error instanceof Error)) throw error
		if (error.constructor !== Error && !(error instanceof HostRefusedError)) throw error
		throw new Failure(error.message)
	}
}

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

const startedOrThrow = (instanceId: string, output: string): void => {
	const state = parseUnitStartState(output)
	if (state === undefined) {
		throw new HostAnswerUnreadableError(`Could not read whether instance ${instanceId} started`)
	}
	if (state.activeState === "active") return
	if (
		state.result === "exec-condition" ||
		RUNNING_UNIT_STATES.some((running) => running === state.signIn)
	) {
		throw new InstanceSignInRunningError(`Sign-in is running for instance ${instanceId}`)
	}
	throw new HostRefusedError(
		`Failed to start instance ${instanceId}: ${state.activeState} ${state.result}`,
	)
}

type LoadedHost = {
	identity: ConnectionIdentity
	options: ConnectOptions
}

export type ExecFlight = { inFlight: boolean }

export const claimedExec = async (
	flight: ExecFlight,
	transport: HostTransport,
	command: string,
	timeoutMs: number,
	stdin?: string,
): Promise<ExecResult> => {
	try {
		return await transport.exec(command, timeoutMs, stdin)
	} catch (error) {
		if (!(error instanceof ChannelLimitReachedError)) flight.inFlight = true
		throw error
	}
}

export type ConfigClaimRepos = {
	instances: Pick<InstanceRepository, "claimForConfig" | "findById" | "latestConfig">
}

export type ConfigClaim = {
	instance: InstanceRow
	config: InstanceConfigRow
}

export const takeConfigClaim = async (
	repos: ConfigClaimRepos,
	scope: OrgScope,
	instanceId: string,
	claimId: string,
	want: { expectedVersion: number },
): Promise<ConfigClaim> => {
	const claimed = await repos.instances.claimForConfig(scope, instanceId, claimId)
	if (!claimed) {
		const present = await repos.instances.findById(scope, instanceId)
		if (!present) throw new InstanceNotFoundError(`Instance not found: ${instanceId}`)
		throw new InstanceBusyError(`Instance ${instanceId} is busy with another change`)
	}
	const config = await repos.instances.latestConfig(scope, instanceId)
	if (!config) throw new InternalError(`No saved settings for instance ${instanceId}`)
	if (config.version !== want.expectedVersion) {
		throw new InstanceConcurrentlyModifiedError(
			`Instance ${instanceId} is at version ${config.version}, not ${want.expectedVersion}`,
		)
	}
	return { instance: claimed, config }
}

export type LifecycleClaimRepos = {
	instances: Pick<InstanceRepository, "claimForLifecycle" | "findById">
}

export const takeLifecycleClaim = async (
	repos: LifecycleClaimRepos,
	scope: OrgScope,
	instanceId: string,
	claimId: string,
): Promise<InstanceRow> => {
	const claimed = await repos.instances.claimForLifecycle(scope, instanceId, claimId)
	if (claimed) return claimed
	const present = await repos.instances.findById(scope, instanceId)
	if (!present) throw new InstanceNotFoundError(`Instance not found: ${instanceId}`)
	if (present.authClaimId !== null && !isAuthClaimStale(present.authClaimedAt)) {
		throw new InstanceAuthInProgressError(
			`Instance ${instanceId} is being authenticated and cannot be changed`,
		)
	}
	throw new InstanceBusyError(`Instance ${instanceId} is busy with another change`)
}

export const createInstanceController = (deps: InstanceControllerDeps) => {
	const scopeOf = (ctx: ActorContext) => ({ organizationId: ctx.organizationId })

	const activeReadAt = new Map<string, number>()
	const activeChecks = new Map<string, Promise<boolean>>()

	const activeKey = (instanceId: string, identity: ConnectionIdentity): string =>
		`${instanceId}\n${JSON.stringify([
			identity.hostname,
			identity.port,
			identity.username,
			identity.sshKeyId,
			identity.hostKeyFingerprint,
		])}`

	const forgetActive = (instanceId: string): void => {
		for (const key of [...activeReadAt.keys(), ...activeChecks.keys()]) {
			if (!key.startsWith(`${instanceId}\n`)) continue
			activeReadAt.delete(key)
			activeChecks.delete(key)
		}
	}

	const requireRunning = async (
		instanceId: string,
		identity: ConnectionIdentity,
		isActive: () => Promise<boolean>,
	): Promise<void> => {
		const key = activeKey(instanceId, identity)
		const readAt = activeReadAt.get(key)
		if (readAt !== undefined && deps.now() - readAt < ACTIVE_RESULT_MAX_AGE_MS) return
		activeReadAt.delete(key)
		const check: Promise<boolean> =
			activeChecks.get(key) ??
			isActive()
				.then((active) => {
					if (active && activeChecks.get(key) === check) activeReadAt.set(key, deps.now())
					return active
				})
				.finally(() => {
					if (activeChecks.get(key) === check) activeChecks.delete(key)
				})
		activeChecks.set(key, check)
		if (!(await check)) throw new LiveChannelUnavailableError("The bot is not running")
	}

	const loadHost = async (scope: OrgScope, hostId: string, need: HostNeed): Promise<LoadedHost> => {
		const host = await deps.hosts.findById(scope, hostId)
		if (!host) throw new InstanceHostNotFoundError(`Host not found: ${hostId}`)
		if (!host.sshKeyId) throw new InstanceHostNotFoundError(`Host ${hostId} has no ssh key`)
		if (!host.hostKeyFingerprint) {
			throw new InstanceHostNotFoundError(`Host ${hostId} has no trusted host key fingerprint`)
		}
		if (!hostMeets(host, need)) {
			throw new InstanceHostNotProvisionedError(`Host ${hostId} is not set up to run bots`)
		}
		const key = await deps.sshKeys.findById(scope, host.sshKeyId)
		if (!key) throw new InstanceHostNotFoundError(`Ssh key not found for host ${hostId}`)
		return {
			identity: {
				hostname: host.hostname,
				port: host.port,
				username: host.username,
				sshKeyId: host.sshKeyId,
				hostKeyFingerprint: host.hostKeyFingerprint,
			},
			options: {
				hostname: host.hostname,
				port: host.port,
				username: host.username,
				privateKey: deps.secrets.open(key.privateKeyEncrypted, key.privateKeyKeyId),
				expectedFingerprint: host.hostKeyFingerprint,
				timeoutMs: CONNECT_TIMEOUT_MS,
			},
		}
	}

	const connectLoaded = async (loaded: LoadedHost): Promise<HostTransport> => {
		const transport = deps.createTransport()
		try {
			await transport.connect(loaded.options)
		} catch (error) {
			await transport.close().catch(() => undefined)
			throw new HostUnreachableError(
				error instanceof Error ? connectFailureReason(error) : COULD_NOT_CONNECT,
			)
		}
		return transport
	}

	const openHost = async (
		scope: OrgScope,
		hostId: string,
		need: HostNeed,
	): Promise<{ transport: HostTransport; identity: ConnectionIdentity }> => {
		const loaded = await loadHost(scope, hostId, need)
		return { transport: await connectLoaded(loaded), identity: loaded.identity }
	}

	const connectToHost = async (
		scope: OrgScope,
		hostId: string,
		need: HostNeed,
	): Promise<HostTransport> => (await openHost(scope, hostId, need)).transport

	const leaseTrustedHost = async (
		scope: OrgScope,
		hostId: string,
		deadlineMs: number,
		need: HostNeed,
	): Promise<Extract<HostReadLease, { kind: "leased" }>> => {
		const leased = await leaseHostReader(deps, scope, hostId, deadlineMs, need)
		switch (leased.kind) {
			case "leased":
				return leased
			case "missing":
				throw new InstanceHostNotFoundError(`Host not found: ${hostId}`)
			case "unprovisioned":
				throw new InstanceHostNotProvisionedError(`Host ${hostId} has never finished provisioning`)
			case "changed":
				throw new HostUnreachableError(COULD_NOT_CONNECT)
			default:
				return assertExhaustive(leased)
		}
	}

	const leaseHost = async (
		scope: OrgScope,
		hostId: string,
		deadlineMs: number,
		need: HostNeed,
	): Promise<HostReader> => (await leaseTrustedHost(scope, hostId, deadlineMs, need)).reader

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

	const storedFrom = (
		instance: InstanceRow,
		saved: InstanceConfigRow | undefined,
	): InstanceConfigInput | undefined => {
		if (!saved) return undefined
		const parsed = instanceConfigStored.safeParse(saved.document)
		if (!parsed.success) {
			throw new InstanceConfigUnusableError(
				`Saved settings for instance ${instance.id} are unusable`,
			)
		}
		return { ...parsed.data, liveControlPort: instance.liveControlPort }
	}

	const storedConfigFor = async (
		scope: OrgScope,
		instance: InstanceRow,
	): Promise<InstanceConfigInput | undefined> =>
		storedFrom(instance, await deps.instances.latestConfig(scope, instance.id))

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

	const documentFrom = (
		instance: InstanceRow,
		saved: InstanceConfigRow | undefined,
	): string | undefined => {
		const stored = storedFrom(instance, saved)
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

	const expectedDocumentFor = async (
		scope: OrgScope,
		instance: InstanceRow,
	): Promise<string | undefined> =>
		documentFrom(instance, await deps.instances.latestConfig(scope, instance.id))

	const storedDocument = (instanceId: string, row: InstanceConfigRow): InstanceConfigStored => {
		const parsed = instanceConfigStored.safeParse(row.document)
		if (!parsed.success) {
			throw new InstanceConfigUnusableError(
				`Saved settings for instance ${instanceId} are unusable`,
			)
		}
		return parsed.data
	}

	const liveEndpointFor = async (
		ctx: ActorContext,
		instanceId: string,
	): Promise<{ hostId: string; port: number; route: string; token: string } | undefined> => {
		const instance = await requireInstance(ctx, instanceId)
		if (!instance.liveControlTokenEncrypted || !instance.liveControlTokenKeyId) return undefined
		const saved = await deps.instances.latestConfig(scopeOf(ctx), instanceId)
		if (!saved) return undefined
		const config = instanceConfigStored.safeParse(saved.document)
		if (!config.success || !config.data.liveControlEnabled) return undefined
		return {
			hostId: instance.hostId,
			port: instance.liveControlPort,
			route: LIVE_CONTROL_ROUTE,
			token: deps.secrets.open(instance.liveControlTokenEncrypted, instance.liveControlTokenKeyId),
		}
	}

	const liveReadTargetFor = async (
		ctx: ActorContext,
		instanceId: string,
	): Promise<LiveReadTarget | undefined> => {
		const endpoint = await liveEndpointFor(ctx, instanceId)
		if (!endpoint) return undefined
		const { reader, identity } = await leaseTrustedHost(
			scopeOf(ctx),
			endpoint.hostId,
			LIVE_CONTROL_TIMEOUT_MS,
			"setUpOnce",
		)
		try {
			await requireRunning(
				instanceId,
				identity,
				async () => (await reader.exec(activeCheckCommand(instanceId))).exitCode === 0,
			)
		} catch (error) {
			reader.release()
			throw error
		}
		return { reader, port: endpoint.port, route: endpoint.route, token: endpoint.token }
	}

	const liveWriteTargetFor = async (
		ctx: ActorContext,
		instanceId: string,
	): Promise<{ target: LiveControlTarget; close: () => Promise<void> } | undefined> => {
		const endpoint = await liveEndpointFor(ctx, instanceId)
		if (!endpoint) return undefined
		const { transport, identity } = await openHost(scopeOf(ctx), endpoint.hostId, "setUpOnce")
		try {
			await requireRunning(
				instanceId,
				identity,
				async () =>
					(
						await transport.exec(
							readCommandText(activeCheckCommand(instanceId)),
							LIVE_CONTROL_TIMEOUT_MS,
						)
					).exitCode === 0,
			)
		} catch (error) {
			await transport.close().catch(() => undefined)
			throw error
		}
		return {
			target: { transport, port: endpoint.port, route: endpoint.route, token: endpoint.token },
			close: async () => {
				await transport.close().catch(() => undefined)
			},
		}
	}

	const readLive = async <T>(
		ctx: ActorContext,
		instanceId: string,
		read: (target: LiveReadTarget) => Promise<T>,
	): Promise<T | undefined> => {
		try {
			const target = await liveReadTargetFor(ctx, instanceId)
			if (!target) return undefined
			try {
				return await read(target)
			} finally {
				target.reader.release()
			}
		} catch (error) {
			if (error instanceof LiveChannelUnavailableError) return undefined
			if (error instanceof TransportInterruptedError) return undefined
			throw error
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
		const transport = await connectToHost(scopeOf(ctx), instance.hostId, "setUpOnce")
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
		const transport = await connectToHost(scopeOf(ctx), instance.hostId, "setUpOnce")
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

	const stopUnitUnderClaim = async (
		flight: ExecFlight,
		transport: HostTransport,
		instanceId: string,
	): Promise<void> => {
		const result = await claimedExec(
			flight,
			transport,
			systemctl(`stop ${shellQuote(unitName(instanceId))}`),
			UNIT_STOP_TIMEOUT_MS,
		)
		if (result.exitCode !== 0) {
			throw new HostRefusedError(`Failed to stop instance ${instanceId}: ${result.stderr.trim()}`)
		}
		forgetActive(instanceId)
	}

	const releasingClaim = async <T>(
		scope: OrgScope,
		instanceId: string,
		claimId: string,
		flight: ExecFlight,
		run: () => Promise<T>,
	): Promise<T> => {
		try {
			return await run()
		} catch (error) {
			if (!flight.inFlight) {
				await deps.instances.releaseConfigClaim(scope, instanceId, claimId).catch(() => undefined)
			}
			throw error
		}
	}

	const finalizeLifecycle = async (
		ctx: ActorContext,
		instanceId: string,
		claimId: string,
		status: "running" | "stopped",
		action: "instance.start" | "instance.restart" | "instance.stop",
	): Promise<InstanceRow> =>
		await deps.withTransaction(async (repos) => {
			const scope = scopeOf(ctx)
			const finalized = await repos.instances.finalizeConfigClaim(scope, instanceId, claimId, {
				status,
				...(status === "running" && { lastExitCode: null }),
			})
			if (!finalized) {
				throw new InstanceBusyError(`Instance ${instanceId} is busy with another change`)
			}
			await repos.audit.record(scope, {
				actorId: ctx.memberId,
				actorLabel: ctx.actorLabel,
				action,
				subjectType: "instance",
				subjectId: instanceId,
				detail: {},
			})
			return finalized
		})

	const startUnderClaim = async (
		ctx: ActorContext,
		instanceId: string,
		verb: "start" | "restart",
	): Promise<InstancePublic> => {
		const scope = scopeOf(ctx)
		const instance = await requireInstance(ctx, instanceId)
		if (instance.status === "needs_auth") {
			throw new InstanceAuthInProgressError(
				`Instance ${instanceId} has not completed its microsoft sign-in`,
			)
		}
		await expectedDocumentFor(scope, instance)

		const loaded = await loadHost(scope, instance.hostId, "runtime")
		const token = randomUUID().replaceAll("-", "")
		const sealed = deps.secrets.seal(token)
		const environment = renderEnvironmentFile({ liveControlToken: token })
		const claimId = randomUUID()
		const flight: ExecFlight = { inFlight: false }

		return await releasingClaim(scope, instanceId, claimId, flight, async () => {
			const { claimed, document } = await deps.withTransaction(async (repos) => {
				const row = await takeLifecycleClaim(repos, scope, instanceId, claimId)
				const saved = await repos.instances.latestConfig(scope, instanceId)
				return { claimed: row, document: documentFrom(row, saved) }
			})

			await failingAs(InstanceStartFailedError, async () => {
				const transport = await connectLoaded(loaded)
				try {
					if (verb === "restart") {
						await failingAs(InstanceStopFailedError, () =>
							stopUnitUnderClaim(flight, transport, claimed.id),
						)
					}

					const wrote = await claimedExec(
						flight,
						transport,
						envWriteUnlessRunningCommand(claimed.id, environment, claimed.liveControlPort),
						INSTANCE_STEP_TIMEOUT_MS,
						environment,
					)
					if (wrote.exitCode !== 0) {
						throw new HostRefusedError(
							`Failed to write the instance environment: ${wrote.stderr.trim()}`,
						)
					}
					const answer = parseEnvWriteAnswer(wrote.stdout)
					if (answer === undefined) {
						throw new HostAnswerUnreadableError(
							`Could not read whether instance ${claimed.id} is running`,
						)
					}
					if (answer === ENV_WRITTEN) {
						const stored = await deps.instances.writeTokenUnderClaim(
							scope,
							instanceId,
							claimId,
							sealed,
						)
						if (!stored) {
							throw new InstanceBusyError(`Instance ${instanceId} is busy with another change`)
						}
					}

					if (document !== undefined) {
						const written = await claimedExec(
							flight,
							transport,
							configWriteCommand(claimed.id, document),
							INSTANCE_STEP_TIMEOUT_MS,
							document,
						)
						if (written.exitCode !== 0) {
							throw new HostRefusedError(
								`Failed to write instance config: ${written.stderr.trim()}`,
							)
						}
					}

					const started = await claimedExec(
						flight,
						transport,
						startUnitCommand(claimed.id),
						UNIT_START_TIMEOUT_MS,
					)
					if (started.exitCode !== 0) {
						throw new HostRefusedError(
							`Failed to start instance ${claimed.id}: ${started.stderr.trim()}`,
						)
					}
					startedOrThrow(claimed.id, started.stdout)
				} finally {
					await transport.close().catch(() => undefined)
				}
			})

			const action = verb === "start" ? "instance.start" : "instance.restart"
			return toInstancePublic(await finalizeLifecycle(ctx, instanceId, claimId, "running", action))
		})
	}

	const saveConfig = async (
		ctx: ActorContext,
		instanceId: string,
		expectedVersion: number,
		compose: (stored: InstanceConfigStored) => InstanceConfigInput,
	): Promise<{ version: number }> => {
		requireCapabilityFor(ctx.role, "config.edit")
		const scope = scopeOf(ctx)
		const instance = await requireInstance(ctx, instanceId)
		const loaded = await loadHost(scope, instance.hostId, "setUpOnce")
		const claimId = randomUUID()
		const flight: ExecFlight = { inFlight: false }

		return await releasingClaim(scope, instanceId, claimId, flight, async () => {
			const { settled, document } = await deps.withTransaction(async (repos) => {
				const claimed = await takeConfigClaim(repos, scope, instanceId, claimId, {
					expectedVersion,
				})
				const checked = instanceConfigInput.parse(
					compose(storedDocument(instanceId, claimed.config)),
				)
				const composed = { ...checked, liveControlPort: claimed.instance.liveControlPort }
				return { settled: composed, document: renderInstanceConfig(composed) }
			})

			const transport = await connectLoaded(loaded)
			try {
				const result = await claimedExec(
					flight,
					transport,
					configWriteCommand(instanceId, document),
					INSTANCE_STEP_TIMEOUT_MS,
					document,
				)
				if (result.exitCode !== 0) {
					throw new HostRefusedError(`Failed to write instance config: ${result.stderr.trim()}`)
				}
			} finally {
				await transport.close().catch(() => undefined)
			}

			return await deps.withTransaction(async (repos) => {
				const finalized = await repos.instances.finalizeConfigClaim(scope, instanceId, claimId, {})
				if (!finalized) {
					throw new InstanceBusyError(`Instance ${instanceId} is busy with another change`)
				}
				const saved = await repos.instances.insertConfigVersion(
					scope,
					instanceId,
					JSON.stringify(settled),
					{ authorId: ctx.memberId, authorLabel: ctx.actorLabel },
				)
				await repos.audit.record(scope, {
					actorId: ctx.memberId,
					actorLabel: ctx.actorLabel,
					action: "instance.config.update",
					subjectType: "instance",
					subjectId: instanceId,
					detail: { version: String(saved.version) },
				})
				return { version: saved.version }
			})
		})
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
			if (host.status !== "ready" || checkHostRuntime(host).kind !== "ready") {
				throw new InstanceHostNotProvisionedError(`Host ${input.hostId} is not ready for a new bot`)
			}

			const onHost = (await deps.instances.list(scopeOf(ctx))).filter(
				(instance) => instance.hostId === input.hostId,
			)
			const takenPorts = onHost.map((instance) => instance.liveControlPort)
			const transport = await connectToHost(scopeOf(ctx), input.hostId, "runtime")
			try {
				const liveControlToken = randomUUID().replaceAll("-", "")
				const sealedToken = deps.secrets.seal(liveControlToken)
				const claimId = randomUUID()
				const flight: ExecFlight = { inFlight: false }
				const claimed: number[] = [...takenPorts]
				let initialConfig = defaultInstanceConfig({
					accountType: input.accountType,
					minecraftAccount: input.minecraftAccount,
					serverAddress: input.serverAddress,
					minecraftVersion: input.minecraftVersion,
				})

				const created = await insertWithFreePort(async () => {
					const port = await unusedPortOnHost(transport, claimed)
					claimed.push(port)
					initialConfig = { ...initialConfig, liveControlPort: port }
					return await deps.withTransaction(async (repos) => {
						await repos.hosts.lockHost(scopeOf(ctx), input.hostId)
						const locked = await repos.hosts.findById(scopeOf(ctx), input.hostId)
						if (locked?.status !== "ready" || checkHostRuntime(locked).kind !== "ready") {
							throw new InstanceHostNotProvisionedError(
								`Host ${input.hostId} is not ready for a new bot`,
							)
						}
						const row = await repos.instances.insert(
							scopeOf(ctx),
							{
								hostId: input.hostId,
								name: input.name,
								accountType: input.accountType,
								minecraftAccount: input.minecraftAccount,
								status: needsInteractiveSignIn(input.accountType) ? "needs_auth" : "stopped",
								liveControlPort: port,
								liveControlTokenEncrypted: sealedToken.ciphertext,
								liveControlTokenKeyId: sealedToken.keyId,
							},
							claimId,
						)
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

				return await releasingClaim(scopeOf(ctx), created.id, claimId, flight, async () => {
					const steps = instanceLayoutSteps({
						instanceId: created.id,
						liveControlPort: created.liveControlPort,
						liveControlToken,
						configDocument: renderInstanceConfig(initialConfig),
					})
					for (const { command, failure, stdin } of steps) {
						const result = await claimedExec(
							flight,
							transport,
							command,
							INSTANCE_STEP_TIMEOUT_MS,
							stdin,
						)
						if (result.exitCode !== 0)
							throw new HostRefusedError(`${failure}: ${result.stderr.trim()}`)
					}
					const finalized = await deps.instances.finalizeConfigClaim(
						scopeOf(ctx),
						created.id,
						claimId,
						{},
					)
					if (!finalized) {
						throw new InstanceBusyError(`Instance ${created.id} is busy with another change`)
					}
					return toInstancePublic(created)
				})
			} finally {
				await transport.close().catch(() => undefined)
			}
		},

		start: async (ctx: ActorContext, instanceId: string): Promise<InstancePublic> => {
			requireCapabilityFor(ctx.role, "instance.start")
			return await startUnderClaim(ctx, instanceId, "start")
		},

		restart: async (ctx: ActorContext, instanceId: string): Promise<InstancePublic> => {
			requireCapabilityFor(ctx.role, "instance.start")
			return await startUnderClaim(ctx, instanceId, "restart")
		},

		stop: async (ctx: ActorContext, instanceId: string): Promise<InstancePublic> => {
			requireCapabilityFor(ctx.role, "instance.start")
			const scope = scopeOf(ctx)
			const instance = await requireInstance(ctx, instanceId)
			const loaded = await loadHost(scope, instance.hostId, "setUpOnce")
			const claimId = randomUUID()
			const flight: ExecFlight = { inFlight: false }

			return await releasingClaim(scope, instanceId, claimId, flight, async () => {
				const claimed = await deps.withTransaction(
					async (repos) => await takeLifecycleClaim(repos, scope, instanceId, claimId),
				)

				await failingAs(InstanceStopFailedError, async () => {
					const transport = await connectLoaded(loaded)
					try {
						await stopUnitUnderClaim(flight, transport, claimed.id)
					} finally {
						await transport.close().catch(() => undefined)
					}
				})

				return toInstancePublic(
					await finalizeLifecycle(ctx, instanceId, claimId, "stopped", "instance.stop"),
				)
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

			await failingAs(InstanceCommandNotSentError, async () => {
				const transport = await connectToHost(scopeOf(ctx), instance.hostId, "runtime")
				try {
					await sendCommand(transport, instance.id, command)
				} finally {
					await transport.close().catch(() => undefined)
				}
			})

			await deps.withTransaction(async (repos) => {
				await repos.audit.record(scopeOf(ctx), {
					actorId: ctx.memberId,
					actorLabel: ctx.actorLabel,
					action: "instance.command",
					subjectType: "instance",
					subjectId: instanceId,
					detail: { command: redactCommand(command) },
				})
			})
		},

		readConsole: async (ctx: ActorContext, instanceId: string, lines: number): Promise<string> => {
			requireCapabilityFor(ctx.role, "console.read")
			const instance = await requireInstance(ctx, instanceId)

			return await failingAs(InstanceConsoleUnreadableError, async () => {
				const reader = await leaseHost(
					scopeOf(ctx),
					instance.hostId,
					CONSOLE_READ_DEADLINE_MS,
					"runtime",
				)
				try {
					return await readConsole(reader, instance.id, lines)
				} finally {
					reader.release()
				}
			})
		},

		readLiveStatus: async (
			ctx: ActorContext,
			instanceId: string,
		): Promise<McpSessionStatus | undefined> => {
			requireCapabilityFor(ctx.role, "instance.read")
			return await readLive(ctx, instanceId, readSessionStatus)
		},

		readLiveChat: async (
			ctx: ActorContext,
			instanceId: string,
		): Promise<McpChatEntry[] | undefined> => {
			requireCapabilityFor(ctx.role, "console.read")
			return await readLive(ctx, instanceId, readChatHistory)
		},

		readLiveEvents: async (
			ctx: ActorContext,
			instanceId: string,
		): Promise<McpEventPage | undefined> => {
			requireCapabilityFor(ctx.role, "console.read")
			return await readLive(ctx, instanceId, readRecentEvents)
		},

		readLiveWorld: async (
			ctx: ActorContext,
			instanceId: string,
		): Promise<McpWorldState | undefined> => {
			requireCapabilityFor(ctx.role, "instance.read")
			return await readLive(ctx, instanceId, readWorldState)
		},

		readLiveEntities: async (
			ctx: ActorContext,
			instanceId: string,
		): Promise<McpEntityList | undefined> => {
			requireCapabilityFor(ctx.role, "instance.read")
			return await readLive(ctx, instanceId, readEntities)
		},

		readLiveInventory: async (
			ctx: ActorContext,
			instanceId: string,
		): Promise<McpInventory | undefined> => {
			requireCapabilityFor(ctx.role, "instance.read")
			return await readLive(ctx, instanceId, readInventory)
		},

		readLivePlayerStats: async (
			ctx: ActorContext,
			instanceId: string,
		): Promise<McpPlayerStats | undefined> => {
			requireCapabilityFor(ctx.role, "instance.read")
			return await readLive(ctx, instanceId, readPlayerStats)
		},

		readLiveStatusEffects: async (
			ctx: ActorContext,
			instanceId: string,
		): Promise<McpStatusEffect[] | undefined> => {
			requireCapabilityFor(ctx.role, "instance.read")
			return await readLive(ctx, instanceId, readStatusEffects)
		},

		readLiveBots: async (
			ctx: ActorContext,
			instanceId: string,
		): Promise<McpLoadedBot[] | undefined> => {
			requireCapabilityFor(ctx.role, "instance.read")
			return await readLive(ctx, instanceId, readLoadedBots)
		},

		readLivePlayers: async (
			ctx: ActorContext,
			instanceId: string,
		): Promise<string[] | undefined> => {
			requireCapabilityFor(ctx.role, "instance.read")
			return await readLive(ctx, instanceId, readPlayersList)
		},

		dropInventoryItem: async (
			ctx: ActorContext,
			instanceId: string,
			itemType: string,
			count: number,
		): Promise<void> => {
			requireCapabilityFor(ctx.role, "console.write")
			const target = await liveWriteTargetFor(ctx, instanceId)
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
			const target = await liveWriteTargetFor(ctx, instanceId)
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
		): Promise<InstanceConfigView | undefined> => {
			requireCapabilityFor(ctx.role, "instance.read")
			const instance = await requireInstance(ctx, instanceId)
			const row = await deps.instances.latestConfig(scopeOf(ctx), instanceId)
			if (!row) return undefined
			const parsed = instanceConfigStored.safeParse(row.document)
			if (!parsed.success) return undefined
			return {
				config: { ...parsed.data, liveControlPort: instance.liveControlPort },
				version: row.version,
			}
		},

		updateSettings: async (
			ctx: ActorContext,
			instanceId: string,
			settings: InstanceSettingsInput,
			expectedVersion: number,
		): Promise<{ version: number }> =>
			await saveConfig(ctx, instanceId, expectedVersion, (stored) => ({
				...settings,
				...usableBots(instanceId, stored),
			})),

		updateBotConfig: async (
			ctx: ActorContext,
			instanceId: string,
			bots: InstanceBotsInput,
			expectedVersion: number,
		): Promise<{ version: number }> =>
			await saveConfig(ctx, instanceId, expectedVersion, (stored) => ({ ...stored, ...bots })),

		hostMetrics: async (ctx: ActorContext, hostId: string): Promise<HostMetrics> => {
			requireCapabilityFor(ctx.role, "instance.read")
			const reader = await leaseHost(scopeOf(ctx), hostId, HOST_METRICS_TIMEOUT_MS, "setUpOnce")
			try {
				return await readHostMetrics(reader)
			} finally {
				reader.release()
			}
		},

		reconcileHost: async (ctx: ActorContext, hostId: string): Promise<HostReconciliation> => {
			requireCapabilityFor(ctx.role, "instance.read")

			const scope = scopeOf(ctx)
			const host = await deps.hosts.findById(scope, hostId)
			if (!host) return { hostId, reachable: false, reason: "misconfigured" }
			const ready = checkHostRuntime(host)
			if (ready.kind !== "ready") return { hostId, reachable: false, reason: "unprovisioned" }
			const runtime = unitRuntimeFor(ready.host)
			const instances = (await deps.instances.list(scope)).filter(
				(instance) => instance.hostId === hostId,
			)
			const schedules = (await deps.schedules.list(scope)).filter((schedule) =>
				instances.some((instance) => instance.id === schedule.instanceId),
			)
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

			let reader: HostReader
			try {
				reader = await leaseHost(scope, hostId, RECONCILE_DEADLINE_MS, "runtime")
			} catch (error) {
				const reason = error instanceof Error ? reasonFor(error) : "failed"
				return { hostId, reachable: false, reason }
			}

			const expected = expectedUnits(instances, schedules, renderScheduleUnits, runtime)
			let observed: Awaited<ReturnType<typeof reconcileHostOverTransport>>
			try {
				observed = await reconcileHostOverTransport(
					reader,
					hostId,
					runtime,
					instances,
					expected,
					expectedConfigs,
				)
			} catch (error) {
				const reason = error instanceof HostAnswerUnreadableError ? "unreadable" : "interrupted"
				return { hostId, reachable: false, reason }
			} finally {
				reader.release()
			}
			for (const [id, player] of observed.seenPlayers) {
				const known = instances.find((each) => each.id === id)
				if (known && known.minecraftUsername !== player) {
					await deps.instances
						.update(scope, id, { minecraftUsername: player })
						.catch(() => undefined)
				}
			}
			for (const [id, lastExitCode] of observed.failures) {
				await deps.instances.recordUnitFailure(scope, id, lastExitCode).catch(() => undefined)
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
			sendableLine(input.command)
			refuseStoredCredential(input.command)

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
					detail: { schedule: input.name, command: redactCommand(input.command) },
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
						command: redactCommand(removed.command),
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

			const transport = await connectToHost(scope, instance.hostId, "runtime")
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
					detail: { command: redactCommand(row.command), schedule: row.name },
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
			return await beginAuthentication(deps, ctx, instanceId, forgetActive)
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
			const scope = scopeOf(ctx)
			const instance = await requireInstance(ctx, instanceId)
			const loaded = await loadHost(scope, instance.hostId, "setUpOnce")
			const claimId = randomUUID()
			const flight: ExecFlight = { inFlight: false }

			try {
				const claimed = await deps.withTransaction(
					async (repos) => await takeLifecycleClaim(repos, scope, instanceId, claimId),
				)

				const transport = await connectLoaded(loaded)
				try {
					const exitOf = async (command: string, timeoutMs: number): Promise<number> =>
						(await claimedExec(flight, transport, command, timeoutMs)).exitCode
					const stillInUse = () =>
						new InstanceStillInUseError(`Instance ${instanceId} is still in use on its host`)
					const unfinished = () =>
						new InstanceRemovalFailedError(
							`Instance ${instanceId} could not be fully removed from its host`,
						)

					if ((await exitOf(removeTimersCommand(claimed.id), REMOVAL_STEP_TIMEOUT_MS)) !== 0) {
						throw unfinished()
					}
					await claimedExec(flight, transport, stopUnitsCommand(claimed.id), UNIT_STOP_TIMEOUT_MS)
					forgetActive(claimed.id)
					if ((await exitOf(removeContainersCommand(claimed.id), REMOVAL_STEP_TIMEOUT_MS)) !== 0) {
						throw stillInUse()
					}
					if ((await exitOf(verifyGoneCommand(claimed.id), REMOVAL_STEP_TIMEOUT_MS)) !== 0) {
						throw stillInUse()
					}
					const deleted = await exitOf(
						deleteDirectoryCommand(claimed.id),
						DIRECTORY_DELETE_TIMEOUT_MS,
					)
					if (endedByDeadline(deleted)) throw stillInUse()
					if (deleted !== 0) throw unfinished()
					if ((await exitOf(verifyGoneCommand(claimed.id), REMOVAL_STEP_TIMEOUT_MS)) !== 0) {
						throw stillInUse()
					}
				} finally {
					await transport.close().catch(() => undefined)
				}

				await deps.withTransaction(async (repos) => {
					const removed = await repos.instances.deleteUnderClaim(scope, instanceId, claimId)
					if (!removed) {
						throw new InstanceBusyError(`Instance ${instanceId} is busy with another change`)
					}
					await repos.audit.record(scope, {
						actorId: ctx.memberId,
						actorLabel: ctx.actorLabel,
						action: "instance.remove",
						subjectType: "instance",
						subjectId: instanceId,
						detail: {},
					})
				})
			} catch (error) {
				if (!flight.inFlight) {
					await deps.instances.releaseConfigClaim(scope, instanceId, claimId).catch(() => undefined)
				}
				throw error
			}
		},
	}

	return controller
}

export type InstanceController = ReturnType<typeof createInstanceController>
