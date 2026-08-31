import { createFakeTransport } from "@open-mcc/transport"
import { describe, expect, it, vi } from "vitest"
import { beginAuthentication, DEVICE_CODE_PATTERN } from "./authenticate"

const FAST_POLL = { attempts: 2, intervalMs: 1 }

import { InstanceAuthInProgressError } from "./instance.controller"

const owner = {
	organizationId: "org-1",
	memberId: "member-1",
	actorLabel: "owner@example.com",
	role: "owner",
} as const

const instanceRow = (overrides: Record<string, unknown> = {}) => ({
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

const makeDeps = (journal: string, overrides: Record<string, unknown> = {}) => {
	const transport = createFakeTransport({})
	const original = transport.exec
	transport.exec = async (command: string, timeoutMs: number, stdin?: string) =>
		command.includes("cat ")
			? { stdout: journal, stderr: "", exitCode: 0 }
			: await original(command, timeoutMs, stdin)

	const instances = {
		findById: vi.fn(async () => instanceRow()),
		claimForAuth: vi.fn(async () =>
			instanceRow({ authClaimId: "attempt-1", authClaimedAt: new Date() }),
		),
		releaseAuthClaim: vi.fn(async () => true),
		update: vi.fn(async () => instanceRow()),
	}
	const audit = { record: vi.fn(async () => undefined) }

	return {
		transport,
		instances,
		audit,
		deps: {
			instances,
			hosts: {
				findById: vi.fn(async () => ({
					id: "host-1",
					organizationId: "org-1",
					sshKeyId: "key-1",
					hostKeyFingerprint: "SHA256:trusted",
					hostname: "10.0.0.1",
					port: 22,
					username: "root",
				})),
			},
			sshKeys: {
				findById: vi.fn(async () => ({ privateKeyEncrypted: "sealed", privateKeyKeyId: "k1" })),
			},
			secrets: {
				open: () => "PRIVATE KEY",
				seal: () => ({ ciphertext: "", keyId: "k1" }),
				activeKeyId: "k1",
			},
			createTransport: () => transport,
			instancesRoot: "/srv/open-mcc",
			withTransaction: async (fn: (repos: unknown) => Promise<unknown>) =>
				await fn({ instances, audit }),
			...overrides,
		},
	}
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
		await beginAuthentication(deps as never, owner as never, "abc123", FAST_POLL)
		const stopAt = transport.commands.findIndex((each) => each.includes("systemctl stop"))
		const authAt = transport.commands.findIndex((each) => each.includes("MinecraftClient"))
		expect(stopAt).toBeGreaterThanOrEqual(0)
		expect(stopAt).toBeLessThan(authAt)
	})

	it("runs the authentication session as the instance's own user", async () => {
		const { deps, transport } = makeDeps(DEVICE_CODE_OUTPUT)
		await beginAuthentication(deps as never, owner as never, "abc123", FAST_POLL)
		expect(transport.commands.find((each) => each.includes("MinecraftClient"))).toContain(
			"runuser -u 'mcc-abc123'",
		)
	})

	it("surfaces the pairing code without carrying anything the client wrote afterwards", async () => {
		const withToken = `${DEVICE_CODE_OUTPUT}\nrefresh_token=eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9`
		const { deps } = makeDeps(withToken)
		const result = await beginAuthentication(deps as never, owner as never, "abc123", FAST_POLL)
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
		await expect(
			beginAuthentication(deps as never, owner as never, "abc123", FAST_POLL),
		).rejects.toThrow(InstanceAuthInProgressError)
	})

	it("releases the claim when the session fails, rather than holding it for the whole lease", async () => {
		const { deps, transport, instances } = makeDeps("no code here at all")
		await expect(
			beginAuthentication(deps as never, owner as never, "abc123", FAST_POLL),
		).rejects.toThrow(/device code/i)
		const claimedWith = instances.claimForAuth.mock.calls.at(0)?.at(2)
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
		await beginAuthentication(deps as never, owner as never, "abc123", FAST_POLL)
		expect(instances.releaseAuthClaim).not.toHaveBeenCalled()
	})
})
