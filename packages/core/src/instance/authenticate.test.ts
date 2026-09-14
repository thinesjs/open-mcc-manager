import type {
	AuditEventRow,
	HostRow,
	InstanceCommandRow,
	InstanceRow,
	InstanceScheduleRow,
	SshKeyRow,
} from "@open-mcc/db"
import { createFakeTransport } from "@open-mcc/transport"
import { describe, expect, it, vi } from "vitest"
import type { AuditEntry, AuditRepository } from "../audit/audit.repository"
import type { HostRepository, OrgScope } from "../host/host.repository"
import type { SshKeyRepository } from "../ssh-key/ssh-key.repository"
import {
	beginAuthentication,
	cancelAuthentication,
	completeAuthentication,
	DEVICE_CODE_PATTERN,
	SESSION_CACHE_FILES,
	VERIFICATION_URI_PATTERN,
} from "./authenticate"
import type { CommandRepository } from "./command.repository"
import {
	type ActorContext,
	InstanceAccountNotInteractiveError,
	InstanceAuthInProgressError,
	type InstanceControllerDeps,
} from "./instance.controller"
import type { InstanceRepository } from "./instance.repository"
import type { ScheduleRepository } from "./schedule.repository"

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
	username: "root",
	mode: "system",
	instancesRoot: "/srv/open-mcc",
	unitDir: "/etc/systemd/system",
	sandboxed: true,
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
	osRelease: null,
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
		withTransaction: async (fn) => await fn({ instances, schedules, commands, audit }),
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
		await beginAuthentication(deps, owner, "abc123", FAST_POLL)
		const stopAt = transport.commands.findIndex((each) => each.includes("stop 'open-mcc@abc123'"))
		const authAt = transport.commands.findIndex((each) =>
			each.includes("start 'open-mcc-auth@abc123.service'"),
		)
		expect(stopAt).toBeGreaterThanOrEqual(0)
		expect(stopAt).toBeLessThan(authAt)
	})

	it("runs the sign-in through its own unit, so it is confined the same way a running instance is", async () => {
		const { deps, transport } = makeDeps(DEVICE_CODE_OUTPUT)

		await beginAuthentication(deps, owner, "abc123", FAST_POLL)

		expect(
			transport.commands.some((each) => each.includes("start 'open-mcc-auth@abc123.service'")),
		).toBe(true)
	})

	it("launches nothing detached from systemd, which would escape the unit's restrictions", async () => {
		const { deps, transport } = makeDeps(DEVICE_CODE_OUTPUT)

		await beginAuthentication(deps, owner, "abc123", FAST_POLL)

		for (const command of transport.commands) {
			expect(command).not.toContain("nohup")
			expect(command).not.toContain("runuser")
			expect(command).not.toContain("pkill")
		}
	})

	it("surfaces the pairing code without carrying anything the client wrote afterwards", async () => {
		const withToken = `${DEVICE_CODE_OUTPUT}\nrefresh_token=eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9`
		const { deps } = makeDeps(withToken)
		const result = await beginAuthentication(deps, owner, "abc123", FAST_POLL)
		expect(result.userCode).toBe("FJDPTLX8")
		expect(result.verificationUri).toBe("https://www.microsoft.com/link")
		expect(JSON.stringify(result)).not.toContain("eyJ")
	})

	it("refuses a second authentication while a claim is live", async () => {
		const { deps } = makeDeps(DEVICE_CODE_OUTPUT)
		deps.instances.claimForAuth = vi.fn(
			async (
				_scope: { organizationId: string },
				_id: string,
				_attemptId: string,
			): Promise<ReturnType<typeof instanceRow> | undefined> => undefined,
		)
		await expect(beginAuthentication(deps, owner, "abc123", FAST_POLL)).rejects.toThrow(
			InstanceAuthInProgressError,
		)
	})

	it("releases the claim when the session fails, rather than holding it for the whole lease", async () => {
		const { deps, transport, instances } = makeDeps("no code here at all")
		await expect(beginAuthentication(deps, owner, "abc123", FAST_POLL)).rejects.toThrow(
			/device code/i,
		)
		const claimedWith = vi.mocked(instances.claimForAuth).mock.calls.at(0)?.at(2)
		expect(claimedWith).toBeDefined()
		expect(instances.releaseAuthClaim).toHaveBeenCalledWith(
			{ organizationId: "org-1" },
			"abc123",
			claimedWith,
		)
		expect(transport.commands.some((each) => each.includes("systemctl stop"))).toBe(true)
	})

	it("holds the claim on success, because the operator needs minutes to finish the login", async () => {
		const { deps, instances } = makeDeps(DEVICE_CODE_OUTPUT)
		await beginAuthentication(deps, owner, "abc123", FAST_POLL)
		expect(instances.releaseAuthClaim).not.toHaveBeenCalled()
	})
})

describe("completeAuthentication", () => {
	const withProbe = (sessionCacheExists: boolean) => {
		const made = makeDeps("")
		const original = made.transport.exec
		made.transport.exec = async (command: string, timeoutMs: number, stdin?: string) => {
			const result = await original(command, timeoutMs, stdin)
			if (!command.includes("SessionCache")) return result
			return { ...result, exitCode: sessionCacheExists ? 0 : 1 }
		}
		return made
	}

	it("reports the instance still unauthenticated when no session cache has appeared", async () => {
		const { deps, transport, instances } = withProbe(false)
		vi.mocked(instances.findById).mockResolvedValue(instanceRow({ status: "needs_auth" }))

		const state = await completeAuthentication(deps, owner, "abc123")

		expect(state).toEqual({ authenticated: false, status: "needs_auth" })
		expect(instances.update).not.toHaveBeenCalled()
		expect(transport.commands.some((each) => each.startsWith("pkill"))).toBe(false)
	})

	it("moves the instance to stopped and clears the device-code log once the cache exists", async () => {
		const { deps, transport, instances } = withProbe(true)
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
				each.includes("rm -f '/srv/open-mcc/instances/abc123/auth.log'"),
			),
		).toBe(true)
	})

	it("accepts either session cache format, since the client reads both", async () => {
		const { deps, transport, instances } = withProbe(true)
		vi.mocked(instances.findById).mockResolvedValue(instanceRow({ status: "needs_auth" }))

		await completeAuthentication(deps, owner, "abc123")

		expect([...SESSION_CACHE_FILES]).toEqual(["SessionCache.db", "SessionCache.ini"])
		expect(
			transport.commands.some(
				(each) =>
					each ===
					"test -s '/srv/open-mcc/instances/abc123/SessionCache.db' || test -s '/srv/open-mcc/instances/abc123/SessionCache.ini'",
			),
		).toBe(true)
	})

	it("does not touch the host for an instance that never needed authenticating", async () => {
		const { deps, transport, instances } = withProbe(true)
		vi.mocked(instances.findById).mockResolvedValue(instanceRow({ status: "running" }))

		const state = await completeAuthentication(deps, owner, "abc123")

		expect(state).toEqual({ authenticated: true, status: "running" })
		expect(transport.commands).toEqual([])
	})
})

describe("orphaned authentication clients", () => {
	const stoppedAuthUnit = (command: string): boolean =>
		command.includes("stop 'open-mcc-auth@abc123.service'")

	it("stops a session left by an earlier attempt before starting a new one", async () => {
		const { deps, transport } = makeDeps(DEVICE_CODE_OUTPUT)

		await beginAuthentication(deps, owner, "abc123", FAST_POLL)

		const stopAt = transport.commands.findIndex(stoppedAuthUnit)
		const startAt = transport.commands.findIndex((each) =>
			each.includes("start 'open-mcc-auth@abc123.service'"),
		)
		expect(stopAt).toBeGreaterThanOrEqual(0)
		expect(stopAt).toBeLessThan(startAt)
	})

	it("does not leave a session running when no device code ever appears", async () => {
		const { deps, transport } = makeDeps("nothing resembling a device code")

		await expect(beginAuthentication(deps, owner, "abc123", FAST_POLL)).rejects.toThrow(
			/device code/i,
		)

		expect(transport.commands.filter(stoppedAuthUnit).length).toBeGreaterThanOrEqual(2)
	})

	it("stops the session on the way out even though the claim is also released", async () => {
		const { deps, transport, instances } = makeDeps("no code")

		await expect(beginAuthentication(deps, owner, "abc123", FAST_POLL)).rejects.toThrow()

		expect(transport.commands.some(stoppedAuthUnit)).toBe(true)
		expect(instances.releaseAuthClaim).toHaveBeenCalled()
	})

	it("clears a failed session so systemd will start it again next time", async () => {
		const { deps, transport } = makeDeps(DEVICE_CODE_OUTPUT)

		await beginAuthentication(deps, owner, "abc123", FAST_POLL)

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
})
