export type { AuditEntry, AuditRepository } from "./audit/audit.repository"
export { createAuditRepository } from "./audit/audit.repository"
export type { SealedValue, SecretStore } from "./crypto/sealed-box"
export {
	createSecretStore,
	generateKeyPair,
	KNOWN_INSECURE_KEY_ID,
	usesKnownInsecureKey,
} from "./crypto/sealed-box"
export type { HostFacts } from "./host/facts"
export { readHostFacts, readSandboxing } from "./host/facts"
export type { HealthInput, HostHealth } from "./host/health"
export { failedUnitsCommand, HOST_HEALTH, healthFor, observeHost } from "./host/health"
export type { HealthPollerDeps, HealthPollerHandle, HealthPollRun } from "./host/health-poller"
export { isPollable, runHealthPoll, startHealthPoller } from "./host/health-poller"
export type {
	ActorContext,
	HostController,
	HostControllerDeps,
	HostTransactionRepos,
	RetrustHostKeyInput,
	WithTransaction,
} from "./host/host.controller"
export {
	CONNECT_TIMEOUT_MS,
	createHostController,
	createHostControllerTransaction,
	FingerprintMismatchError,
	ForbiddenError,
	HostConcurrentlyModifiedError,
	HostHasInstancesError,
	HostMisconfiguredError,
	HostNotFoundError,
	HostProvisioningFailedError,
	HostProvisioningInProgressError,
	SshKeyNotFoundError,
} from "./host/host.controller"
export type {
	HostCreateValues,
	HostKeyTrustUpdate,
	HostRepository,
	HostUpdateValues,
	OrgScope,
} from "./host/host.repository"
export {
	createHostRepository,
	isProvisioningClaimStale,
	PROVISIONING_LEASE_MS,
} from "./host/host.repository"
export type { ProvisionOptions, ProvisionResult } from "./host/provision"
export {
	PROVISION_STEP_TIMEOUT_MS,
	PROVISION_STEPS,
	provisionHost,
	validateInstancesRoot,
} from "./host/provision"
export {
	beginAuthentication,
	DEVICE_CODE_PATTERN,
	DEVICE_CODE_TTL_MS,
	VERIFICATION_URI_PATTERN,
} from "./instance/authenticate"
export type { CommandRepository, ScheduledCommandValues } from "./instance/command.repository"
export { createCommandRepository } from "./instance/command.repository"
export { ALLOWED_CONFIG_KEYS, renderInstanceConfig } from "./instance/config"
export {
	CONTROL_TIMEOUT_MS,
	controlLine,
	DisallowedInternalCommandError,
	INTERNAL_COMMAND_PREFIX,
	INTERNAL_COMMANDS,
	readConsole,
	sendCommand,
} from "./instance/control"
export type { ExitMeaning } from "./instance/exit-code"
export { interpretExitCode, shouldRestartOn } from "./instance/exit-code"
export type { InstanceController } from "./instance/instance.controller"
export {
	createInstanceController,
	createInstanceControllerTransaction,
	HostUnreachableError,
	InstanceAccountNotInteractiveError,
	InstanceAuthInProgressError,
	InstanceConcurrentlyModifiedError,
	InstanceHostNotFoundError,
	InstanceHostNotProvisionedError,
	InstanceNotFoundError,
} from "./instance/instance.controller"
export type {
	InstanceCreateValues,
	InstanceRepository,
	InstanceUpdateValues,
} from "./instance/instance.repository"
export {
	AUTH_LEASE_MS,
	createInstanceRepository,
	isAuthClaimStale,
} from "./instance/instance.repository"
export {
	callLiveTool,
	LIVE_CHAT_MAX_LINES,
	LIVE_CONTROL_TIMEOUT_MS,
	LIVE_EVENT_MAX,
	LiveControlUnauthorizedError,
	LiveResponseTooLargeError,
	readChatHistory,
	readEntities,
	readRecentEvents,
	readSessionStatus,
	readWorldState,
} from "./instance/live-control"
export {
	calendarWeekdayPrefix,
	parseDaysOfWeek,
	renderDaysOfWeek,
	renderOnCalendar,
	renderSleepTimers,
	sleepStartTimer,
	sleepStopTimer,
} from "./instance/schedule"
export type { ScheduleRepository, SleepWindowValues } from "./instance/schedule.repository"
export { createScheduleRepository } from "./instance/schedule.repository"
export type { SchedulerDeps, SchedulerHandle, SchedulerRun } from "./instance/scheduler"
export {
	runSchedulerTick,
	SCHEDULER_ACTOR_LABEL,
	SCHEDULER_TICK_MS,
	startScheduler,
} from "./instance/scheduler"
export { renderEnvironmentFile, validateInstanceId } from "./instance/unit"
export type { SqlRunner } from "./job/executor-adapter"
export { asSqlRunner } from "./job/executor-adapter"
export { createHostTeardownHandler } from "./job/host-teardown.job"
export type { JobQueue, QueueName, SendJob } from "./job/job.queue"
export { createJobQueue, HOST_TEARDOWN_QUEUE, QUEUE_NAMES } from "./job/job.queue"
export { assertExhaustive } from "./lib/exhaustive"
export { redact, redactError } from "./security/redact"
export type { GeneratedSshKeyPair } from "./ssh-key/generate"
export { generateSshKeyPair } from "./ssh-key/generate"
export type {
	SshKeyController,
	SshKeyControllerDeps,
	SshKeyTransactionRepos,
	WithSshKeyTransaction,
} from "./ssh-key/ssh-key.controller"
export {
	createSshKeyController,
	createSshKeyControllerTransaction,
	SshKeyInUseError,
} from "./ssh-key/ssh-key.controller"
export type { SshKeyCreateValues, SshKeyRepository } from "./ssh-key/ssh-key.repository"
export { createSshKeyRepository } from "./ssh-key/ssh-key.repository"
export type { BuildInfo } from "./system/build-info"
export { describeBuild, isDevelopmentBuild, readBuildInfo, sameBuild } from "./system/build-info"
export type {
	ControlPlaneCondition,
	ControlPlaneStatus,
	ProcessRecord,
} from "./system/fleet-status"
export { CONDITION_EXPLANATION, conditionFor, needsAttention } from "./system/fleet-status"
export type { HostMetrics } from "./system/host-metrics"
export {
	HOST_METRICS_COMMAND,
	parseHostMetrics,
	readHostMetrics,
} from "./system/host-metrics"
export type { GrowthVerdict, ManagerMetrics, ProcessSample } from "./system/metrics"
export { assessHeapGrowth, sampleManagerMetrics } from "./system/metrics"
export type { ProcessIdentityRepository } from "./system/process-identity.repository"
export {
	createProcessIdentityRepository,
	startHeartbeat,
} from "./system/process-identity.repository"
