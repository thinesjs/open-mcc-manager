import { createFakeTransport } from "@open-mcc/transport"
import { describe, expect, it, vi } from "vitest"
import {
	createInstanceController,
	ForbiddenError,
	InstanceAuthInProgressError,
	InstanceNotFoundError,
} from "./instance.controller"

const owner = {
	organizationId: "org-1",
	memberId: "member-1",
	actorLabel: "owner@example.com",
	role: "owner",
} as const

const viewer = { ...owner, role: "viewer" } as const
const operator = { ...owner, role: "operator" } as const

const instanceRow = (overrides: Record<string, unknown> = {}) => ({
	id: "abc123",
	organizationId: "org-1",
	hostId: "host-1",
	name: "afk-1",
	minecraftAccount: "afk@example.com",
	status: "stopped",
	lastExitCode: null,
	authClaimId: null,
	authClaimedAt: null,
	createdAt: new Date(),
	...overrides,
})

const hostRow = {
	id: "host-1",
	organizationId: "org-1",
	sshKeyId: "key-1",
	hostKeyFingerprint: "SHA256:trusted",
	hostname: "10.0.0.1",
	port: 22,
	username: "root",
}

const makeDeps = (overrides: Record<string, unknown> = {}) => {
	const transport = createFakeTransport()
	const audit = { record: vi.fn(async () => undefined) }
	const instances = {
		findById: vi.fn(async (): Promise<ReturnType<typeof instanceRow> | undefined> => instanceRow()),
		list: vi.fn(async () => [instanceRow()]),
		insert: vi.fn(async () => instanceRow()),
		update: vi.fn(async () => instanceRow({ status: "running" })),
		delete: vi.fn(async () => true),
		claimForAuth: vi.fn(async () => instanceRow()),
		releaseAuthClaim: vi.fn(async () => true),
		insertConfigVersion: vi.fn(async () => ({ id: "cfg-1", version: 1 })),
		latestConfig: vi.fn(async () => undefined),
	}
	return {
		transport,
		audit,
		instances,
		deps: {
			instances,
			hosts: { findById: vi.fn(async () => hostRow) },
			sshKeys: {
				findById: vi.fn(async () => ({
					privateKeyEncrypted: "sealed",
					privateKeyKeyId: "k1",
				})),
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

describe("instance controller authorization", () => {
	it("refuses a viewer's attempt to start an instance without touching the host", async () => {
		const { deps, transport } = makeDeps()
		const controller = createInstanceController(deps as never)
		await expect(controller.start(viewer as never, "abc123")).rejects.toThrow(ForbiddenError)
		expect(transport.commands).toEqual([])
	})

	it("refuses an operator's attempt to create an instance", async () => {
		const { deps } = makeDeps()
		const controller = createInstanceController(deps as never)
		await expect(
			controller.create(operator as never, {
				hostId: "host-1",
				name: "n",
				minecraftAccount: "a@b.com",
				serverAddress: "play.example.com",
			}),
		).rejects.toThrow(ForbiddenError)
	})

	it("lets an operator send a console command", async () => {
		const { deps, transport } = makeDeps()
		const controller = createInstanceController(deps as never)
		await controller.sendCommand(operator as never, "abc123", "/say hi")
		expect(transport.stdins).toContain("/say hi\n")
	})

	it("refuses a viewer's console write while allowing the read", async () => {
		const { deps } = makeDeps()
		const controller = createInstanceController(deps as never)
		await expect(controller.sendCommand(viewer as never, "abc123", "/say hi")).rejects.toThrow(
			ForbiddenError,
		)
		await expect(controller.readConsole(viewer as never, "abc123", 10)).resolves.toBeDefined()
	})
})

describe("instance controller lifecycle guards", () => {
	it("refuses to start an instance that has not completed its microsoft sign-in", async () => {
		const { deps, transport } = makeDeps()
		deps.instances.findById = vi.fn(async () => instanceRow({ status: "needs_auth" }))
		const controller = createInstanceController(deps as never)
		await expect(controller.start(owner as never, "abc123")).rejects.toThrow(
			InstanceAuthInProgressError,
		)
		expect(transport.commands).toEqual([])
	})

	it("refuses to remove an instance whose auth claim is still live", async () => {
		const { deps, transport } = makeDeps()
		deps.instances.findById = vi.fn(async () =>
			instanceRow({ authClaimId: "attempt-1", authClaimedAt: new Date() }),
		)
		const controller = createInstanceController(deps as never)
		await expect(controller.remove(owner as never, "abc123")).rejects.toThrow(
			InstanceAuthInProgressError,
		)
		expect(transport.commands).toEqual([])
	})

	it("allows removal once the auth claim has gone stale", async () => {
		const { deps } = makeDeps()
		deps.instances.findById = vi.fn(async () =>
			instanceRow({ authClaimId: "attempt-1", authClaimedAt: new Date(Date.now() - 3_600_000) }),
		)
		const controller = createInstanceController(deps as never)
		await expect(controller.remove(owner as never, "abc123")).resolves.toBeUndefined()
	})

	it("reports a missing instance rather than reaching for a host", async () => {
		const { deps, transport } = makeDeps()
		deps.instances.findById = vi.fn(async () => undefined)
		const controller = createInstanceController(deps as never)
		await expect(controller.start(owner as never, "nope")).rejects.toThrow(InstanceNotFoundError)
		expect(transport.commands).toEqual([])
	})
})

describe("instance creation prepares the host", () => {
	it("creates the user, directory and control fifo, and writes the environment as stdin", async () => {
		const { deps, transport } = makeDeps()
		const controller = createInstanceController(deps as never)
		await controller.create(owner as never, {
			hostId: "host-1",
			name: "afk-1",
			minecraftAccount: "afk@example.com",
			serverAddress: "play.example.com",
		})

		const joined = transport.commands.join("\n")
		expect(joined).toContain("useradd -r -g open-mcc")
		expect(joined).toContain("mkfifo -m 0660")
		expect(joined).toContain("/srv/open-mcc/instances/abc123/env")
		expect(transport.stdins.some((each) => each.includes("MCC_SERVER="))).toBe(true)
	})

	it("creates the instance user idempotently so a retry after a partial failure does not fail", async () => {
		const { deps, transport } = makeDeps()
		const controller = createInstanceController(deps as never)
		await controller.create(owner as never, {
			hostId: "host-1",
			name: "afk-1",
			minecraftAccount: "afk@example.com",
			serverAddress: "play.example.com",
		})
		expect(transport.commands.find((each) => each.includes("useradd"))).toContain("|| true")
	})
})
