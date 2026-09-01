import type { AuditEventRow, HostRow, InstanceRow, SshKeyRow } from "@open-mcc/db"
import { createFakeTransport } from "@open-mcc/transport"
import { describe, expect, it, vi } from "vitest"
import type { AuditEntry, AuditRepository } from "../audit/audit.repository"
import type { HostRepository, OrgScope } from "../host/host.repository"
import type { SshKeyRepository } from "../ssh-key/ssh-key.repository"
import {
	beginAuthentication,
	completeAuthentication,
	DEVICE_CODE_PATTERN,
	SESSION_CACHE_FILE,
} from "./authenticate"
import {
	type ActorContext,
	InstanceAuthInProgressError,
	type InstanceControllerDeps,
} from "./instance.controller"
import type { InstanceRepository } from "./instance.repository"

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
	minecraftAccount: "afk@example.com",
	status: "needs_auth",
	lastExitCode: null,
	authClaimId: null,
	authClaimedAt: null,
	createdAt: new Date(),
	...overrides,
})

const DEVICE_CODE_OUTPUT = [
	"Please sign in to your Microsoft account.",
	"To sign in, use a web browser to open the page https://www.microsoft.com/link",
	"and enter the code ABCD-EFGH to authenticate.",
].join("\n")

const hostRow: HostRow = {
	id: "host-1",
	organizationId: "org-1",
	name: "vps",
	hostname: "10.0.0.1",
	port: 22,
	username: "root",
	sshKeyId: "key-1",
	hostKeyAlgorithm: "ssh-ed25519",
	hostKeyFingerprint: "SHA256:trusted",
	hostKeyTrustedBy: null,
	hostKeyTrustedByLabel: "unknown",
	hostKeyTrustedAt: null,
	status: "ready",
	provisioningAttemptId: null,
	provisioningClaimedAt: null,
	osRelease: null,
	cpuCount: null,
	memoryMb: null,
	capacityLimit: null,
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
	const hosts: Pick<HostRepository, "findById"> = { findById: vi.fn(async () => hostRow) }
	const sshKeys: Pick<SshKeyRepository, "findById"> = { findById: vi.fn(async () => sshKeyRow) }

	const deps: InstanceControllerDeps = {
		instances,
		hosts,
		sshKeys,
		secrets: {
			open: () => "PRIVATE KEY",
			seal: () => ({ ciphertext: "", keyId: "k1" }),
			activeKeyId: "k1",
		},
		createTransport: () => transport,
		instancesRoot: "/srv/open-mcc",
		withTransaction: async (fn) => await fn({ instances, audit }),
		...overrides,
	}

	return { transport, instances, audit, deps }
}

describe("device code pattern", () => {
	it("matches a pairing code and not a token", () => {
		expect(DEVICE_CODE_PATTERN.test("ABCD-EFGH")).toBe(true)
		expect(DEVICE_CODE_PATTERN.test("eyJhbGciOiJSUzI1NiIs")).toBe(false)
	})
})

describe("beginAuthentication", () => {
	it("stops the unit before starting an authentication session", async () => {
		const { deps, transport } = makeDeps(DEVICE_CODE_OUTPUT)
		await beginAuthentication(deps, owner, "abc123", FAST_POLL)
		const stopAt = transport.commands.findIndex((each) => each.includes("systemctl stop"))
		const authAt = transport.commands.findIndex((each) => each.includes("MinecraftClient"))
		expect(stopAt).toBeGreaterThanOrEqual(0)
		expect(stopAt).toBeLessThan(authAt)
	})

	it("runs the authentication session as the instance's own user", async () => {
		const { deps, transport } = makeDeps(DEVICE_CODE_OUTPUT)
		await beginAuthentication(deps, owner, "abc123", FAST_POLL)
		expect(transport.commands.find((each) => each.includes("MinecraftClient"))).toContain(
			"runuser -u 'mcc-abc123'",
		)
	})

	it("surfaces the pairing code without carrying anything the client wrote afterwards", async () => {
		const withToken = `${DEVICE_CODE_OUTPUT}\nrefresh_token=eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9`
		const { deps } = makeDeps(withToken)
		const result = await beginAuthentication(deps, owner, "abc123", FAST_POLL)
		expect(result.userCode).toBe("ABCD-EFGH")
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
			if (!command.includes(SESSION_CACHE_FILE)) return result
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

	it("reads the session cache mcc actually writes, in the instance's own directory", async () => {
		const { deps, transport, instances } = withProbe(true)
		vi.mocked(instances.findById).mockResolvedValue(instanceRow({ status: "needs_auth" }))

		await completeAuthentication(deps, owner, "abc123")

		expect(SESSION_CACHE_FILE).toBe("SessionCache.ini")
		expect(
			transport.commands.some(
				(each) => each === "test -s '/srv/open-mcc/instances/abc123/SessionCache.ini'",
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
