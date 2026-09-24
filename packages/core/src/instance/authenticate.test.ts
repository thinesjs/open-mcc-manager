import type { DeviceCodeChallenge } from "@open-mcc/contracts"
import type {
	AuditEventRow,
	HostRow,
	InstanceCommandRow,
	InstanceRow,
	InstanceScheduleRow,
	SshKeyRow,
} from "@open-mcc/db"
import {
	ChannelLimitReachedError,
	ChannelOpenTimedOutError,
	createFakeTransport,
} from "@open-mcc/transport"
import { describe, expect, it, vi } from "vitest"
import type { AuditEntry, AuditRepository } from "../audit/audit.repository"
import type { HostRepository, OrgScope } from "../host/host.repository"
import { AUTH_UNIT_NAME, INSTANCE_UNIT_NAME, renderUnitTemplates } from "../host/unit-template"
import type { SshKeyRepository } from "../ssh-key/ssh-key.repository"
import {
	AUTH_SESSION_TIMEOUT_MS,
	AUTH_START_TIMEOUT_MS,
	beginAuthentication,
	cancelAuthentication,
	completeAuthentication,
	DEVICE_CODE_PATTERN,
	DEVICE_CODE_POLL_ATTEMPTS,
	DEVICE_CODE_POLL_INTERVAL_MS,
	SESSION_CACHE_ABSENT_EXIT,
	SESSION_CACHE_FILES,
	SESSION_CACHE_NO_STATE_DIR_EXIT,
	SESSION_CACHE_UNREADABLE_EXIT,
	sessionCacheProbeCommand,
	startAuthCommand,
	VERIFICATION_URI_PATTERN,
} from "./authenticate"
import type { CommandRepository } from "./command.repository"
import {
	type ActorContext,
	HostUnreachableError,
	InstanceAccountNotInteractiveError,
	InstanceAuthInProgressError,
	InstanceBusyError,
	type InstanceControllerDeps,
	InstanceHostNotFoundError,
	InstanceNotFoundError,
	InstanceSignInDidNotStartError,
	InstanceSignInNoDeviceCodeError,
	InstanceSignInOtherAccountError,
} from "./instance.controller"
import { AUTH_LEASE_MS, type InstanceRepository } from "./instance.repository"
import { UNIT_STOP_TIMEOUT_MS } from "./removal"
import type { ScheduleRepository } from "./schedule.repository"
import type { InstanceTaskRepos } from "./task.repository"
import { stopAuthCommand } from "./unit"

const FAST_POLL = { attempts: 2, intervalMs: 1 }

const owner: ActorContext = {
	organizationId: "org-1",
	memberId: "member-1",
	actorLabel: "owner@example.com",
	role: "owner",
}

const instanceRow = (overrides: Partial<InstanceRow> = {}): InstanceRow => ({
	id: "abc123",
	organizationId: "org-1",
	hostId: "host-1",
	name: "afk-1",
	accountType: "microsoft",
	liveControlPort: 33333,
	liveControlTokenEncrypted: null,
	liveControlTokenKeyId: null,
	minecraftAccount: "afk@example.com",
	minecraftUsername: null,
	status: "needs_auth",
	lastExitCode: null,
	authClaimId: null,
	authClaimedAt: null,
	configClaimId: null,
	configClaimedAt: null,
	playerListOffset: "0",
	playerListFingerprint: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
	playerListCursorVersion: "0",
	createdAt: new Date(),
	...overrides,
})

const DEVICE_CODE_OUTPUT = [
	"Minecraft Console Client v26.2 - for MC 1.4.6 to 26.2 - Github.com/MCCTeam",
	"Connecting to Microsoft...",
	"To sign in, open https://www.microsoft.com/link in your browser and enter the code: FJDPTLX8",
	"Cannot open browser",
	"Waiting for authentication to complete...",
].join("\n")

const hostRow: HostRow = {
	id: "host-1",
	organizationId: "org-1",
	name: "vps",
	hostname: "10.0.0.1",
	port: 22,
	username: "mcc",
	networkStack: "slirp4netns",
	architecture: "x64",
	osId: "debian",
	osName: "Debian GNU/Linux 12 (bookworm)",
	failedUnits: null,
	teardownError: null,
	teardownRequestedAt: null,
	sshKeyId: "key-1",
	hostKeyAlgorithm: "ssh-ed25519",
	hostKeyFingerprint: "SHA256:trusted",
	hostKeyTrustedBy: null,
	hostKeyTrustedByLabel: "unknown",
	hostKeyTrustedAt: null,
	status: "ready",
	provisioningAttemptId: null,
	provisioningClaimedAt: null,
	provisioningStep: null,
	provisioningStepIndex: null,
	provisioningStepTotal: null,
	provisioningError: null,
	osRelease: "systemd 252",
	cpuCount: null,
	memoryMb: null,
	lastSeenAt: null,
	createdAt: new Date(),
}

const sshKeyRow: SshKeyRow = {
	id: "key-1",
	organizationId: "org-1",
	name: "key-1",
	publicKey: "ssh-ed25519 AAAA",
	privateKeyEncrypted: "sealed",
	privateKeyKeyId: "k1",
	createdAt: new Date(),
}

const auditEventRow = (overrides: Partial<AuditEventRow> = {}): AuditEventRow => ({
	id: "audit-1",
	organizationId: "org-1",
	actorId: "member-1",
	actorLabel: "owner@example.com",
	action: "instance.authenticate",
	subjectType: "instance",
	subjectId: "abc123",
	detail: {},
	createdAt: new Date(),
	...overrides,
})

const scheduleRow = (overrides: Partial<InstanceScheduleRow> = {}): InstanceScheduleRow => ({
	id: "sched-1",
	organizationId: "org-1",
	instanceId: "abc123",
	daysOfWeek: "Mon,Tue",
	stopMinuteOfDay: 18 * 60 + 50,
	startMinuteOfDay: 19 * 60 + 30,
	timezone: "Asia/Kuala_Lumpur",
	enabled: true,
	createdAt: new Date(),
	...overrides,
})

const commandRow = (overrides: Partial<InstanceCommandRow> = {}): InstanceCommandRow => ({
	id: "cmd-1",
	organizationId: "org-1",
	instanceId: "abc123",
	name: "morning wave",
	command: "/say good morning",
	daysOfWeek: "Mon",
	minuteOfDay: 540,
	timezone: "UTC",
	enabled: true,
	lastRunAt: null,
	lastRunError: null,
	createdAt: new Date(),
	...overrides,
})

const makeDeps = (journal: string, overrides: Partial<InstanceControllerDeps> = {}) => {
	const transport = createFakeTransport({})
	const original = transport.exec
	transport.exec = async (command: string, timeoutMs: number, stdin?: string) =>
		command.includes("cat ")
			? { stdout: journal, stderr: "", exitCode: 0 }
			: await original(command, timeoutMs, stdin)

	const instances: InstanceRepository = {
		findById: vi.fn(async () => instanceRow()),
		list: vi.fn(async () => [instanceRow()]),
		insert: vi.fn(async () => instanceRow()),
		claimForAuth: vi.fn(async () =>
			instanceRow({ authClaimId: "attempt-1", authClaimedAt: new Date() }),
		),
		releaseAuthClaim: vi.fn(async () => true),
		claimForConfig: vi.fn(async () => instanceRow()),
		claimForLifecycle: vi.fn(async () => instanceRow()),
		finalizeConfigClaim: vi.fn(async () => instanceRow()),
		recordUnitFailure: vi.fn(async () => true),
		releaseConfigClaim: vi.fn(async () => true),
		writeTokenUnderClaim: vi.fn(async () => true),
		deleteUnderClaim: vi.fn(async () => true),
		update: vi.fn(async () => instanceRow()),
		delete: vi.fn(async () => true),
		insertConfigVersion: vi.fn(async () => {
			throw new Error("not used")
		}),
		latestConfig: vi.fn(async () => undefined),
	}
	const audit: Pick<AuditRepository, "record"> = {
		record: vi.fn(async (_scope: OrgScope, entry: AuditEntry) => auditEventRow({ ...entry })),
	}
	const schedules: ScheduleRepository = {
		upsert: vi.fn(async () => scheduleRow()),
		findByInstance: vi.fn(async () => undefined),
		list: vi.fn(async () => []),
		delete: vi.fn(async () => true),
	}
	const commands: CommandRepository = {
		upsert: vi.fn(async () => commandRow()),
		listForInstance: vi.fn(async () => []),
		listEnabledAcrossOrganizations: vi.fn(async () => []),
		delete: vi.fn(async () => true),
		deleteReturning: vi.fn(async () => commandRow()),
		claimRun: vi.fn(async () => true),
		recordRun: vi.fn(async () => undefined),
	}
	const hosts: Pick<HostRepository, "findById"> = { findById: vi.fn(async () => hostRow) }
	const sshKeys: Pick<SshKeyRepository, "findById"> = { findById: vi.fn(async () => sshKeyRow) }

	const tasks: InstanceTaskRepos = {
		insert: vi.fn(async () => {
			throw new Error("tasks.insert is not exercised here")
		}),
		update: vi.fn(async () => undefined),
		replaceSteps: vi.fn(async () => undefined),
		replaceTimes: vi.fn(async () => undefined),
		listForInstance: vi.fn(async () => []),
		findById: vi.fn(async () => undefined),
		deleteReturning: vi.fn(async () => undefined),
		recordSignal: vi.fn(async () => true),
		hasJoinedAs: vi.fn(async () => false),
		readSignalCursor: vi.fn(async () => null),
		writeSignalCursor: vi.fn(async () => undefined),
	}

	const deps: InstanceControllerDeps = {
		instances,
		schedules,
		commands,
		hosts,
		sshKeys,
		secrets: {
			open: () => "PRIVATE KEY",
			seal: () => ({ ciphertext: "", keyId: "k1" }),
			activeKeyId: "k1",
		},
		createTransport: () => transport,
		readConnections: {
			lease: async () => {
				throw new Error("signing in must never take a shared read lease")
			},
		},
		withTransaction: async (fn) =>
			await fn({
				instances,
				schedules,
				commands,
				tasks,
				audit,
				hosts: { ...hosts, lockHost: vi.fn(async () => undefined) },
			}),
		now: () => Date.now(),
		...overrides,
	}

	return { transport, instances, audit, deps }
}

describe("device code pattern", () => {
	it("matches the code in the line mcc 26.2 actually prints", () => {
		const match = DEVICE_CODE_PATTERN.exec(DEVICE_CODE_OUTPUT)
		expect(match?.[1]).toBe("FJDPTLX8")
	})

	it("matches an unhyphenated eight-character code, which is the form observed", () => {
		expect(DEVICE_CODE_PATTERN.exec("and enter the code: 3VZL6XLW")?.[1]).toBe("3VZL6XLW")
	})

	it("still matches a hyphenated code, in case the format varies", () => {
		expect(DEVICE_CODE_PATTERN.exec("enter the code: ABCD-EFGH")?.[1]).toBe("ABCD-EFGH")
	})

	it("does not mistake a bearer token for a pairing code", () => {
		expect(DEVICE_CODE_PATTERN.test("eyJhbGciOiJSUzI1NiIs")).toBe(false)
	})

	it("finds the verification uri mcc prints", () => {
		expect(VERIFICATION_URI_PATTERN.exec(DEVICE_CODE_OUTPUT)?.[1]).toBe(
			"https://www.microsoft.com/link",
		)
	})
})

describe("beginAuthentication", () => {
	it("stops the unit before starting an authentication session", async () => {
		const { deps, transport } = makeDeps(DEVICE_CODE_OUTPUT)
		await beginAuthentication(deps, owner, "abc123", () => undefined, FAST_POLL)
		const stopAt = transport.commands.findIndex((each) => each.includes("stop 'open-mcc@abc123'"))
		const authAt = transport.commands.findIndex((each) =>
			each.includes("start 'open-mcc-auth@abc123.service'"),
		)
		expect(stopAt).toBeGreaterThanOrEqual(0)
		expect(stopAt).toBeLessThan(authAt)
	})

	it("runs the sign-in through its own unit, so it is confined the same way a running instance is", async () => {
		const { deps, transport } = makeDeps(DEVICE_CODE_OUTPUT)

		await beginAuthentication(deps, owner, "abc123", () => undefined, FAST_POLL)

		expect(
			transport.commands.some((each) => each.includes("start 'open-mcc-auth@abc123.service'")),
		).toBe(true)
	})

	it("launches nothing detached from systemd, which would escape the unit's restrictions", async () => {
		const { deps, transport } = makeDeps(DEVICE_CODE_OUTPUT)

		await beginAuthentication(deps, owner, "abc123", () => undefined, FAST_POLL)

		for (const command of transport.commands) {
			expect(command).not.toContain("nohup")
			expect(command).not.toContain("runuser")
			expect(command).not.toContain("pkill")
		}
	})

	it("surfaces the pairing code without carrying anything the client wrote afterwards", async () => {
		const withToken = `${DEVICE_CODE_OUTPUT}\nrefresh_token=eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9`
		const { deps } = makeDeps(withToken)
		const result = await beginAuthentication(deps, owner, "abc123", () => undefined, FAST_POLL)
		expect(result.userCode).toBe("FJDPTLX8")
		expect(result.verificationUri).toBe("https://www.microsoft.com/link")
		expect(JSON.stringify(result)).not.toContain("eyJ")
	})

	const refusingClaim = (held: InstanceRow) => {
		const { deps } = makeDeps(DEVICE_CODE_OUTPUT)
		deps.instances.claimForAuth = vi.fn(
			async (
				_scope: { organizationId: string },
				_id: string,
				_attemptId: string,
			): Promise<ReturnType<typeof instanceRow> | undefined> => undefined,
		)
		deps.instances.findById = vi.fn(async () => held)
		return deps
	}

	it("refuses a second authentication while a sign-in claim is live", async () => {
		const deps = refusingClaim(instanceRow({ authClaimId: "attempt-0", authClaimedAt: new Date() }))
		await expect(
			beginAuthentication(deps, owner, "abc123", () => undefined, FAST_POLL),
		).rejects.toThrow(InstanceAuthInProgressError)
	})

	it("reports a bot removed while the claim was being taken as gone, not as a sign-in", async () => {
		const { deps } = makeDeps(DEVICE_CODE_OUTPUT)
		deps.instances.claimForAuth = vi.fn(
			async (
				_scope: { organizationId: string },
				_id: string,
				_attemptId: string,
			): Promise<ReturnType<typeof instanceRow> | undefined> => undefined,
		)
		deps.instances.findById = vi
			.fn(async (): Promise<ReturnType<typeof instanceRow> | undefined> => undefined)
			.mockResolvedValueOnce(instanceRow())

		await expect(
			beginAuthentication(deps, owner, "abc123", () => undefined, FAST_POLL),
		).rejects.toBeInstanceOf(InstanceNotFoundError)
	})

	it("refuses a sign-in that a live config claim is holding up, as busy rather than as a sign-in", async () => {
		const deps = refusingClaim(
			instanceRow({ configClaimId: "claim-1", configClaimedAt: new Date() }),
		)
		await expect(
			beginAuthentication(deps, owner, "abc123", () => undefined, FAST_POLL),
		).rejects.toBeInstanceOf(InstanceBusyError)
	})

	it("releases the claim when the session fails, rather than holding it for the whole lease", async () => {
		const { deps, transport, instances } = makeDeps("no code here at all")
		await expect(
			beginAuthentication(deps, owner, "abc123", () => undefined, FAST_POLL),
		).rejects.toThrow(/device code/i)
		const claimedWith = vi.mocked(instances.claimForAuth).mock.calls.at(0)?.at(2)
		expect(claimedWith).toBeDefined()
		expect(instances.releaseAuthClaim).toHaveBeenCalledWith(
			{ organizationId: "org-1" },
			"abc123",
			claimedWith,
		)
		expect(transport.commands.some((each) => each.includes("systemctl --user stop"))).toBe(true)
	})

	it("holds the claim on success, because the operator needs minutes to finish the login", async () => {
		const { deps, instances } = makeDeps(DEVICE_CODE_OUTPUT)
		await beginAuthentication(deps, owner, "abc123", () => undefined, FAST_POLL)
		expect(instances.releaseAuthClaim).not.toHaveBeenCalled()
	})

	it("holds the claim when the stop it sent may still be running on the host", async () => {
		const { deps, transport, instances } = makeDeps(DEVICE_CODE_OUTPUT)
		const inner = transport.exec
		transport.exec = async (command, timeoutMs, stdin) => {
			if (command.includes("systemctl --user stop")) {
				throw new ChannelOpenTimedOutError("the channel opened too late")
			}
			return await inner(command, timeoutMs, stdin)
		}

		await expect(
			beginAuthentication(deps, owner, "abc123", () => undefined, FAST_POLL),
		).rejects.toBeInstanceOf(ChannelOpenTimedOutError)

		expect(instances.releaseAuthClaim).not.toHaveBeenCalled()
	})

	it("holds the claim when the cleanup stop it sent may still be running on the host", async () => {
		const { deps, transport, instances } = makeDeps("no code here at all")
		const cleanup = stopAuthCommand("abc123")
		let seen = 0
		const inner = transport.exec
		transport.exec = async (command, timeoutMs, stdin) => {
			if (command === cleanup) {
				seen += 1
				if (seen > 1) throw new ChannelOpenTimedOutError("too slow")
			}
			return await inner(command, timeoutMs, stdin)
		}

		await expect(
			beginAuthentication(deps, owner, "abc123", () => undefined, FAST_POLL),
		).rejects.toThrow(/device code/i)

		expect(seen).toBe(2)
		expect(instances.releaseAuthClaim).not.toHaveBeenCalled()
	})

	it("gives the claim back when the host refused the session channel outright", async () => {
		const { deps, transport, instances } = makeDeps(DEVICE_CODE_OUTPUT)
		const inner = transport.exec
		transport.exec = async (command, timeoutMs, stdin) => {
			if (command.includes("systemctl --user stop")) {
				throw new ChannelLimitReachedError("no channel")
			}
			return await inner(command, timeoutMs, stdin)
		}

		await expect(
			beginAuthentication(deps, owner, "abc123", () => undefined, FAST_POLL),
		).rejects.toBeInstanceOf(ChannelLimitReachedError)

		expect(instances.releaseAuthClaim).toHaveBeenCalled()
	})
})

describe("completeAuthentication", () => {
	const PROBE_ACCOUNT = "afk@example.com"

	const STATE_PROBE =
		'd="$HOME/.local/share/open-mcc/instances/abc123/state"; [ -d "$d" ] || exit 3; out=$(find "$d" -maxdepth 1 -name SessionCache.db -type f -size +0 -print -quit); rc=$?; [ "$rc" -eq 0 ] || exit 2; [ -n "$out" ] || exit 1; LC_ALL=C grep -a -i -q -F -e \'afk@example.com\' "$out"; found=$?; [ "$found" -eq 0 ] && exit 0; [ "$found" -eq 1 ] && exit 4; exit 2'

	const withProbe = (status: 0 | 1 | 2 | 3 | 4) => {
		const made = makeDeps("")
		const original = made.transport.exec
		made.transport.exec = async (command: string, timeoutMs: number, stdin?: string) => {
			const result = await original(command, timeoutMs, stdin)
			if (command === STATE_PROBE) return { ...result, exitCode: status }
			if (command.includes("SessionCache")) return { ...result, exitCode: 1 }
			return result
		}
		return made
	}

	it("builds the probe for the state directory alone, by type and size, following no link", () => {
		expect(sessionCacheProbeCommand("abc123", PROBE_ACCOUNT)).toBe(STATE_PROBE)
		expect(() => sessionCacheProbeCommand("abc%i", PROBE_ACCOUNT)).toThrow()
	})

	it("reports the instance still unauthenticated when no session cache has appeared", async () => {
		const { deps, transport, instances } = withProbe(1)
		vi.mocked(instances.findById).mockResolvedValue(instanceRow({ status: "needs_auth" }))

		const state = await completeAuthentication(deps, owner, "abc123")

		expect(state).toEqual({ authenticated: false, status: "needs_auth" })
		expect(instances.update).not.toHaveBeenCalled()
		expect(transport.commands.some((each) => each.startsWith("pkill"))).toBe(false)
	})

	it("refuses an account that never signs in with a code, before reaching the host", async () => {
		const { deps, transport, instances } = withProbe(0)
		vi.mocked(instances.findById).mockResolvedValue(
			instanceRow({ accountType: "offline", minecraftAccount: "Steve", status: "stopped" }),
		)

		await expect(completeAuthentication(deps, owner, "abc123")).rejects.toThrow(
			InstanceAccountNotInteractiveError,
		)

		expect(transport.commands).toEqual([])
	})

	it("refuses a sign-in that used another Microsoft account, leaving the instance waiting", async () => {
		const { deps, transport, instances } = withProbe(4)
		vi.mocked(instances.findById).mockResolvedValue(instanceRow({ status: "needs_auth" }))

		await expect(completeAuthentication(deps, owner, "abc123")).rejects.toThrow(
			InstanceSignInOtherAccountError,
		)

		expect(instances.update).not.toHaveBeenCalled()
		expect(transport.commands.some((each) => each.startsWith("pkill"))).toBe(false)
	})

	it("moves the instance to stopped and clears the device-code log once the cache exists", async () => {
		const { deps, transport, instances } = withProbe(0)
		vi.mocked(instances.findById).mockResolvedValue(
			instanceRow({ status: "needs_auth", authClaimId: "attempt-1", authClaimedAt: new Date() }),
		)

		const state = await completeAuthentication(deps, owner, "abc123")

		expect(state).toEqual({ authenticated: true, status: "stopped" })
		expect(instances.update).toHaveBeenCalledWith({ organizationId: "org-1" }, "abc123", {
			status: "stopped",
		})
		expect(instances.releaseAuthClaim).toHaveBeenCalledWith(
			{ organizationId: "org-1" },
			"abc123",
			"attempt-1",
		)
		expect(
			transport.commands.some((each) =>
				each.includes('rm -f "$HOME"/.local/share/open-mcc/instances/abc123/auth.log'),
			),
		).toBe(true)
	})

	it("finds the cache in state/, where the client now writes it, and nowhere else", async () => {
		const { deps, transport, instances } = withProbe(0)
		vi.mocked(instances.findById).mockResolvedValue(instanceRow({ status: "needs_auth" }))

		const state = await completeAuthentication(deps, owner, "abc123")

		expect(state).toEqual({ authenticated: true, status: "stopped" })
		expect([...SESSION_CACHE_FILES]).toEqual(["SessionCache.db"])
		expect(transport.commands).toContain(STATE_PROBE)
	})

	it("throws when the state directory cannot be read, never reporting not signed in yet", async () => {
		const { deps, instances } = withProbe(2)
		vi.mocked(instances.findById).mockResolvedValue(instanceRow({ status: "needs_auth" }))

		await expect(completeAuthentication(deps, owner, "abc123")).rejects.toThrow(/signed in/)
		expect(instances.update).not.toHaveBeenCalled()
		expect(instances.releaseAuthClaim).not.toHaveBeenCalled()
	})

	it("never starts the bot when sign-in completes or is cancelled", async () => {
		const completed = withProbe(0)
		vi.mocked(completed.instances.findById).mockResolvedValue(instanceRow({ status: "needs_auth" }))
		await completeAuthentication(completed.deps, owner, "abc123")
		const cancelled = withProbe(0)
		vi.mocked(cancelled.instances.findById).mockResolvedValue(instanceRow({ status: "needs_auth" }))
		await cancelAuthentication(cancelled.deps, owner, "abc123")

		expect(
			[...completed.transport.commands, ...cancelled.transport.commands].filter((command) =>
				/ start /.test(command),
			),
		).toEqual([])
	})

	it("keeps the old two-name probe out of the host commands", async () => {
		const { deps, transport, instances } = withProbe(0)
		vi.mocked(instances.findById).mockResolvedValue(instanceRow({ status: "needs_auth" }))

		await completeAuthentication(deps, owner, "abc123")

		expect(transport.commands.some((each) => each.includes("test -s"))).toBe(false)
	})

	it("★ reports a row whose status moved underneath as not signed in, never as signed in", async () => {
		const { deps, transport, instances } = withProbe(1)
		vi.mocked(instances.findById).mockResolvedValue(instanceRow({ status: "error" }))

		const state = await completeAuthentication(deps, owner, "abc123")

		expect(state).toEqual({ authenticated: false, status: "error" })
		expect(transport.commands).toContain(STATE_PROBE)
		expect(instances.update).not.toHaveBeenCalled()
	})

	it("reports a row whose status moved underneath as signed in only once the client has recorded it", async () => {
		const { deps, instances, audit } = withProbe(0)
		vi.mocked(instances.findById).mockResolvedValue(instanceRow({ status: "running" }))

		const state = await completeAuthentication(deps, owner, "abc123")

		expect(state).toEqual({ authenticated: true, status: "running" })
		expect(instances.update).not.toHaveBeenCalled()
		expect(audit.record).not.toHaveBeenCalled()
	})

	it("★ answers from the probe and never from the status, in both directions, for every status", async () => {
		const answered: string[] = []
		const asked: string[] = []
		for (const status of ["created", "stopped", "running", "error"] as const) {
			for (const [exitCode, authenticated] of [
				[1, false],
				[0, true],
			] as const) {
				const { deps, transport, instances } = withProbe(exitCode)
				vi.mocked(instances.findById).mockResolvedValue(instanceRow({ status }))

				const state = await completeAuthentication(deps, owner, "abc123")

				expect(state).toEqual({ authenticated, status })
				answered.push(`${status}:${exitCode}:${state.authenticated}`)
				if (transport.commands.includes(STATE_PROBE)) asked.push(`${status}:${exitCode}`)
			}
		}

		expect(asked).toEqual(answered.map((each) => each.split(":").slice(0, 2).join(":")))
		expect(answered).toHaveLength(8)
	})

	it("reports no sign-in rather than throwing when the state directory is not there yet", async () => {
		const { deps, instances } = withProbe(3)
		vi.mocked(instances.findById).mockResolvedValue(instanceRow({ status: "needs_auth" }))

		const state = await completeAuthentication(deps, owner, "abc123")

		expect(state).toEqual({ authenticated: false, status: "needs_auth" })
		expect(instances.update).not.toHaveBeenCalled()
	})

	it("tells a missing state directory apart from one it could not read", () => {
		expect(SESSION_CACHE_NO_STATE_DIR_EXIT).not.toBe(SESSION_CACHE_UNREADABLE_EXIT)
		expect(SESSION_CACHE_NO_STATE_DIR_EXIT).not.toBe(SESSION_CACHE_ABSENT_EXIT)
		expect(sessionCacheProbeCommand("abc123", PROBE_ACCOUNT)).toContain(
			`|| exit ${SESSION_CACHE_NO_STATE_DIR_EXIT}`,
		)
	})
})

describe("orphaned authentication clients", () => {
	const stoppedAuthUnit = (command: string): boolean =>
		command.includes("stop 'open-mcc-auth@abc123.service'")

	it("stops a session left by an earlier attempt before starting a new one", async () => {
		const { deps, transport } = makeDeps(DEVICE_CODE_OUTPUT)

		await beginAuthentication(deps, owner, "abc123", () => undefined, FAST_POLL)

		const stopAt = transport.commands.findIndex(stoppedAuthUnit)
		const startAt = transport.commands.findIndex((each) =>
			each.includes("start 'open-mcc-auth@abc123.service'"),
		)
		expect(stopAt).toBeGreaterThanOrEqual(0)
		expect(stopAt).toBeLessThan(startAt)
	})

	it("does not leave a session running when no device code ever appears", async () => {
		const { deps, transport } = makeDeps("nothing resembling a device code")

		await expect(
			beginAuthentication(deps, owner, "abc123", () => undefined, FAST_POLL),
		).rejects.toThrow(/device code/i)

		expect(transport.commands.filter(stoppedAuthUnit).length).toBeGreaterThanOrEqual(2)
	})

	it("stops the session on the way out even though the claim is also released", async () => {
		const { deps, transport, instances } = makeDeps("no code")

		await expect(
			beginAuthentication(deps, owner, "abc123", () => undefined, FAST_POLL),
		).rejects.toThrow()

		expect(transport.commands.some(stoppedAuthUnit)).toBe(true)
		expect(instances.releaseAuthClaim).toHaveBeenCalled()
	})

	it("clears a failed session so systemd will start it again next time", async () => {
		const { deps, transport } = makeDeps(DEVICE_CODE_OUTPUT)

		await beginAuthentication(deps, owner, "abc123", () => undefined, FAST_POLL)

		expect(
			transport.commands.some((each) =>
				each.includes("reset-failed 'open-mcc-auth@abc123.service'"),
			),
		).toBe(true)
	})
})

describe("cancelAuthentication", () => {
	it("refuses an account that never signs in with a code, before reaching the host or the audit log", async () => {
		const { deps, transport, instances, audit } = makeDeps("")
		vi.mocked(instances.findById).mockResolvedValue(
			instanceRow({ accountType: "offline", minecraftAccount: "Steve", status: "stopped" }),
		)
		const connect = vi.spyOn(transport, "connect")

		await expect(cancelAuthentication(deps, owner, "abc123")).rejects.toBeInstanceOf(
			InstanceAccountNotInteractiveError,
		)
		expect(connect).not.toHaveBeenCalled()
		expect(transport.commands).toEqual([])
		expect(instances.releaseAuthClaim).not.toHaveBeenCalled()
		expect(audit.record).not.toHaveBeenCalled()
	})

	it("still stops a microsoft sign-in and records that it was cancelled", async () => {
		const { deps, transport, audit } = makeDeps("")

		await expect(cancelAuthentication(deps, owner, "abc123")).resolves.toEqual({
			authenticated: false,
			status: "needs_auth",
		})
		expect(
			transport.commands.some((each) => each.includes("stop 'open-mcc-auth@abc123.service'")),
		).toBe(true)
		expect(audit.record).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ detail: expect.objectContaining({ phase: "cancelled" }) }),
		)
	})

	it("still stops a sign-in on a host a failed Repair setup left in error", async () => {
		const { deps, transport } = makeDeps("", {
			hosts: {
				findById: vi.fn(async () => ({ ...hostRow, status: "error" as const })),
			},
		})

		await expect(cancelAuthentication(deps, owner, "abc123")).resolves.toEqual({
			authenticated: false,
			status: "needs_auth",
		})
		expect(
			transport.commands.some((each) => each.includes("stop 'open-mcc-auth@abc123.service'")),
		).toBe(true)
	})

	it("refuses a host that was never set up, before reaching it", async () => {
		const { deps, transport } = makeDeps("", {
			hosts: { findById: vi.fn(async () => ({ ...hostRow, osRelease: null })) },
		})
		const connect = vi.spyOn(transport, "connect")

		await expect(cancelAuthentication(deps, owner, "abc123")).rejects.toBeInstanceOf(
			InstanceHostNotFoundError,
		)
		expect(connect).not.toHaveBeenCalled()
	})
})

describe("signing in through a host that cannot be reached", () => {
	const refused = () =>
		createFakeTransport(
			{},
			{
				connect: Object.assign(new Error("connect ECONNREFUSED 203.0.113.9:2222"), {
					code: "ECONNREFUSED",
				}),
			},
		)

	it("reports starting a sign-in as unreachable and lets the claim go", async () => {
		const { deps, instances } = makeDeps("", { createTransport: refused })

		const outcome = beginAuthentication(deps, owner, "abc123", () => undefined, FAST_POLL)

		await expect(outcome).rejects.toBeInstanceOf(HostUnreachableError)
		await expect(outcome).rejects.toThrow(/^The server refused the connection$/)
		expect(instances.releaseAuthClaim).toHaveBeenCalled()
	})

	it("reports finishing a sign-in as unreachable", async () => {
		const { deps } = makeDeps("", { createTransport: refused })

		const outcome = completeAuthentication(deps, owner, "abc123")

		await expect(outcome).rejects.toBeInstanceOf(HostUnreachableError)
		await expect(outcome).rejects.toThrow(/^The server refused the connection$/)
	})

	it("reports cancelling a sign-in as unreachable, writing no audit row", async () => {
		const { deps, audit } = makeDeps("", { createTransport: refused })

		const outcome = cancelAuthentication(deps, owner, "abc123")

		await expect(outcome).rejects.toBeInstanceOf(HostUnreachableError)
		await expect(outcome).rejects.toThrow(/^The server refused the connection$/)
		expect(audit.record).not.toHaveBeenCalled()
	})
})

describe("stopping the instance before a sign-in", () => {
	it("gives the stop longer than the unit can wait before killing the client", async () => {
		const { deps, transport } = makeDeps(DEVICE_CODE_OUTPUT)
		const stopSeconds = Number(
			/^TimeoutStopSec=(\d+)$/m.exec(
				renderUnitTemplates({
					networkStack: "slirp4netns",
					imageId: "b54641a0139b45834e25e82fa2cf2be60bafa6a1b6a22868bb1df7182a27a7b9",
				})[INSTANCE_UNIT_NAME] ?? "",
			)?.[1],
		)

		await beginAuthentication(deps, owner, "abc123", () => undefined, FAST_POLL)

		const stopAt = transport.commands.findIndex((each) => each.includes("stop 'open-mcc@abc123'"))
		expect(stopSeconds).toBeGreaterThan(0)
		expect(stopAt).toBeGreaterThanOrEqual(0)
		expect(transport.timeouts[stopAt]).toBeGreaterThan(2 * stopSeconds * 1000)
	})
})

describe("a sign-in the host never started", () => {
	const START_TIMED_OUT = [
		"Job for open-mcc-auth@abc123.service failed because a timeout was exceeded.",
		'See "systemctl --user status open-mcc-auth@abc123.service" and "journalctl --user -xeu open-mcc-auth@abc123.service" for details.',
	].join("\n")

	const LOG_NOT_CLEARED =
		"rm: cannot remove '/home/mcc/.local/share/open-mcc/instances/abc123/auth.log': Permission denied"

	const startExiting = (exitCode: number, stderr: string, journal: string) => {
		const made = makeDeps(journal)
		const sent: string[] = []
		const inner = made.transport.exec
		made.transport.exec = async (command: string, timeoutMs: number, stdin?: string) => {
			sent.push(command)
			return command === startAuthCommand("abc123")
				? { stdout: "", stderr, exitCode }
				: await inner(command, timeoutMs, stdin)
		}
		return { ...made, sent }
	}

	const polls = (sent: readonly string[]): readonly string[] =>
		sent.filter((each) => each.startsWith("cat "))

	const failureOf = async (run: Promise<DeviceCodeChallenge>): Promise<Error> => {
		try {
			await run
		} catch (error) {
			if (error instanceof Error) return error
			throw error
		}
		throw new Error("the sign-in was expected to fail and did not")
	}

	it("★ tells a start the host refused from a client that stayed quiet, by the exit alone", async () => {
		const refused = startExiting(1, START_TIMED_OUT, "")
		const quiet = startExiting(0, "", "")

		const failed = await failureOf(
			beginAuthentication(refused.deps, owner, "abc123", () => undefined, FAST_POLL),
		)
		const silent = await failureOf(
			beginAuthentication(quiet.deps, owner, "abc123", () => undefined, FAST_POLL),
		)

		expect(failed).toBeInstanceOf(InstanceSignInDidNotStartError)
		expect(failed.message).toMatch(/did not start/i)
		expect(failed.message).not.toMatch(/device code|polling window/i)
		expect(silent).toBeInstanceOf(InstanceSignInNoDeviceCodeError)
		expect(silent).not.toBeInstanceOf(InstanceSignInDidNotStartError)
		expect(silent.message).toMatch(/did not present a device code/i)
	})

	it("★ spends none of the polling window on a code a start that never ran cannot produce", async () => {
		const refused = startExiting(1, START_TIMED_OUT, "")
		const quiet = startExiting(0, "", "")

		await expect(
			beginAuthentication(refused.deps, owner, "abc123", () => undefined, FAST_POLL),
		).rejects.toBeInstanceOf(InstanceSignInDidNotStartError)
		await expect(
			beginAuthentication(quiet.deps, owner, "abc123", () => undefined, FAST_POLL),
		).rejects.toThrow(/device code/i)

		expect(polls(refused.sent)).toEqual([])
		expect(polls(quiet.sent)).toHaveLength(FAST_POLL.attempts)
	})

	it("★ raises a typed refusal when the start worked and no code came, never a bare Error", async () => {
		const quiet = startExiting(0, "", "")

		const silent = await failureOf(
			beginAuthentication(quiet.deps, owner, "abc123", () => undefined, FAST_POLL),
		)

		expect(silent.constructor).not.toBe(Error)
		expect(silent).toBeInstanceOf(InstanceSignInNoDeviceCodeError)
		expect(polls(quiet.sent)).toHaveLength(FAST_POLL.attempts)
	})

	it("★ never hands back a code an earlier attempt left behind when the log was not cleared", async () => {
		const { deps, instances } = startExiting(1, LOG_NOT_CLEARED, DEVICE_CODE_OUTPUT)

		await expect(
			beginAuthentication(deps, owner, "abc123", () => undefined, FAST_POLL),
		).rejects.toBeInstanceOf(InstanceSignInDidNotStartError)

		expect(instances.update).not.toHaveBeenCalled()
	})

	it("★ gives the claim back, having stopped the unit a job timeout may have left starting", async () => {
		const { deps, sent, instances } = startExiting(1, START_TIMED_OUT, "")

		await expect(
			beginAuthentication(deps, owner, "abc123", () => undefined, FAST_POLL),
		).rejects.toBeInstanceOf(InstanceSignInDidNotStartError)

		const claimedWith = vi.mocked(instances.claimForAuth).mock.calls.at(0)?.at(2)
		expect(claimedWith).toBeDefined()
		expect(instances.releaseAuthClaim).toHaveBeenCalledWith(
			{ organizationId: "org-1" },
			"abc123",
			claimedWith,
		)
		expect(sent.lastIndexOf(stopAuthCommand("abc123"))).toBeGreaterThan(
			sent.indexOf(startAuthCommand("abc123")),
		)
	})

	it("carries the host's own words on to the server log, for a reader who has to act", async () => {
		const { deps } = startExiting(1, START_TIMED_OUT, "")

		const failed = await failureOf(
			beginAuthentication(deps, owner, "abc123", () => undefined, FAST_POLL),
		)

		expect(failed.message).toContain("failed because a timeout was exceeded")
	})
})

describe("what each step of a sign-in is given, against what that step can take", () => {
	const UNIT_RUNTIME = {
		networkStack: "slirp4netns",
		imageId: "b54641a0139b45834e25e82fa2cf2be60bafa6a1b6a22868bb1df7182a27a7b9",
	} as const

	const signInUnit = (): string => renderUnitTemplates(UNIT_RUNTIME)[AUTH_UNIT_NAME] ?? ""

	const jobSeconds = (): number =>
		Number(
			/^JobTimeoutSec=(\d+)$/m.exec(signInUnit().slice(0, signInUnit().indexOf("[Service]")))?.[1],
		)

	const waitsUnderTheClaim = async (): Promise<number[]> => {
		const waits: number[] = [AUTH_SESSION_TIMEOUT_MS]
		const { deps, transport } = makeDeps("no code here at all")
		const inner = transport.exec
		transport.exec = async (command, timeoutMs, stdin) => {
			waits.push(timeoutMs)
			return await inner(command, timeoutMs, stdin)
		}

		await expect(
			beginAuthentication(deps, owner, "abc123", () => undefined, {
				attempts: DEVICE_CODE_POLL_ATTEMPTS,
				intervalMs: 0,
			}),
		).rejects.toThrow(/device code/i)

		return waits
	}

	it("waits longer for the sign-in unit's start than that unit's own start job may take", async () => {
		const { deps, transport } = makeDeps(DEVICE_CODE_OUTPUT)

		await beginAuthentication(deps, owner, "abc123", () => undefined, FAST_POLL)

		const startedAt = transport.commands.indexOf(startAuthCommand("abc123"))

		expect(jobSeconds()).toBeGreaterThan(0)
		expect(startedAt).toBeGreaterThanOrEqual(0)
		expect(transport.timeouts[startedAt]).toBeGreaterThanOrEqual(
			jobSeconds() * 1000 + AUTH_SESSION_TIMEOUT_MS,
		)
	})

	it("buys the start its own wait instead of lengthening the one four other steps share", async () => {
		const waits = await waitsUnderTheClaim()
		const startedAt = waits.findIndex((wait) => wait > UNIT_STOP_TIMEOUT_MS)

		expect(waits.filter((wait) => wait === AUTH_SESSION_TIMEOUT_MS).length).toBe(
			DEVICE_CODE_POLL_ATTEMPTS + 3,
		)
		expect(waits.filter((wait) => wait > UNIT_STOP_TIMEOUT_MS)).toEqual([AUTH_START_TIMEOUT_MS])
		expect(startedAt).toBeGreaterThan(0)
	})

	it("spends less of the sign-in lease than the lease has, counting every wait it can issue", async () => {
		const waits = await waitsUnderTheClaim()
		const sleeps = (DEVICE_CODE_POLL_ATTEMPTS - 1) * DEVICE_CODE_POLL_INTERVAL_MS

		const spent = waits.reduce((total, wait) => total + wait, 0) + sleeps

		expect(spent).toBe(538_000)
		expect(spent).toBeLessThan(AUTH_LEASE_MS)
	})
})

describe("signing in on a host with no recorded runtime", () => {
	const SIGN_IN_PATHS = [
		[
			"starting",
			async (deps: InstanceControllerDeps) => {
				await beginAuthentication(deps, owner, "abc123", () => undefined, FAST_POLL)
			},
		],
		[
			"completing",
			async (deps: InstanceControllerDeps) => {
				await completeAuthentication(deps, owner, "abc123")
			},
		],
		[
			"cancelling",
			async (deps: InstanceControllerDeps) => {
				await cancelAuthentication(deps, owner, "abc123")
			},
		],
	] as const

	describe.each([
		["no network stack", { networkStack: null }],
		["no architecture", { architecture: null }],
	] as const)("recording %s", (_case, missing) => {
		it.each(SIGN_IN_PATHS)("refuses %s a sign-in before reaching the host", async (_path, run) => {
			const { deps, transport } = makeDeps("", {
				hosts: { findById: vi.fn(async () => ({ ...hostRow, ...missing })) },
			})
			const connect = vi.spyOn(transport, "connect")

			await expect(run(deps)).rejects.toBeInstanceOf(InstanceHostNotFoundError)
			expect(connect).not.toHaveBeenCalled()
			expect(transport.commands).toEqual([])
		})

		it("lets the sign-in claim go when it refuses to start one", async () => {
			const { deps, instances } = makeDeps("", {
				hosts: { findById: vi.fn(async () => ({ ...hostRow, ...missing })) },
			})

			await expect(
				beginAuthentication(deps, owner, "abc123", () => undefined, FAST_POLL),
			).rejects.toBeInstanceOf(InstanceHostNotFoundError)
			expect(instances.releaseAuthClaim).toHaveBeenCalledWith(
				{ organizationId: "org-1" },
				"abc123",
				expect.any(String),
			)
		})
	})
})
