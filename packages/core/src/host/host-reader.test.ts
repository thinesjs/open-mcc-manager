import type { HostRow, SshKeyRow } from "@open-mcc/db"
import {
	type ConnectOptions,
	createFakeTransport,
	createReadConnections,
	READ_CONNECTION_CHANNEL_LIMIT,
	READ_CONNECTION_HARD_AGE_MS,
	READ_CONNECTION_IDLE_MS,
} from "@open-mcc/transport"
import { describe, expect, it, vi } from "vitest"
import { HostUnreachableError } from "./host.controller"
import type { OrgScope } from "./host.repository"
import { hostReadKey, leaseHostReader } from "./host-reader"

const row = (overrides: Partial<HostRow> = {}): HostRow => ({
	id: "host-1",
	organizationId: "org-1",
	name: "vps",
	hostname: "10.0.0.1",
	port: 22,
	username: "mcc",
	networkStack: null,
	architecture: null,
	osId: "debian",
	osName: "Debian GNU/Linux 12 (bookworm)",
	failedUnits: null,
	teardownError: null,
	teardownRequestedAt: null,
	sshKeyId: "key-1",
	hostKeyAlgorithm: "ssh-ed25519",
	hostKeyFingerprint: "SHA256:first",
	hostKeyTrustedBy: null,
	hostKeyTrustedByLabel: "owner",
	hostKeyTrustedAt: null,
	status: "ready",
	osRelease: "Debian GNU/Linux 12 (bookworm)",
	cpuCount: null,
	memoryMb: null,
	lastSeenAt: null,
	provisioningAttemptId: null,
	provisioningClaimedAt: null,
	provisioningStep: null,
	provisioningStepIndex: null,
	provisioningStepTotal: null,
	provisioningError: null,
	createdAt: new Date(),
	...overrides,
})

const keyRow: SshKeyRow = {
	id: "key-1",
	organizationId: "org-1",
	name: "key-1",
	publicKey: "ssh-ed25519 AAAA",
	privateKeyEncrypted: "sealed",
	privateKeyKeyId: "k1",
	createdAt: new Date(),
}

const SCOPE: OrgScope = { organizationId: "org-1" }

const harness = (
	reads: (call: number) => HostRow | undefined,
	options: { connectFailure?: Error; key?: SshKeyRow | undefined } = {},
) => {
	const made: Array<ReturnType<typeof createFakeTransport>> = []
	const expectedFingerprints: string[] = []
	const readConnections = createReadConnections({
		createTransport: () => {
			const transport = createFakeTransport(
				{},
				options.connectFailure ? { connect: options.connectFailure } : {},
			)
			made.push(transport)
			return {
				...transport,
				connect: async (connectOptions: ConnectOptions) => {
					expectedFingerprints.push(connectOptions.expectedFingerprint)
					await transport.connect(connectOptions)
				},
			}
		},
		idleMs: READ_CONNECTION_IDLE_MS,
		hardAgeMs: READ_CONNECTION_HARD_AGE_MS,
		channelLimit: READ_CONNECTION_CHANNEL_LIMIT,
		now: () => Date.now(),
	})
	let calls = 0
	const hosts = {
		findById: vi.fn(async (scope: OrgScope, hostId: string) => {
			calls += 1
			const found = reads(calls)
			return found && found.organizationId === scope.organizationId && found.id === hostId
				? found
				: undefined
		}),
	}
	const sshKeys = { findById: vi.fn(async () => ("key" in options ? options.key : keyRow)) }
	const deps = { hosts, sshKeys, secrets: { open: () => "PRIVATE KEY" }, readConnections }
	return { deps, made, readConnections, expectedFingerprints, sshKeys }
}

describe("leasing a reader on a host's current trust", () => {
	it("hands out a reader on the row it re-read, and releases cleanly", async () => {
		const { deps, readConnections } = harness(() => row())

		const leased = await leaseHostReader(deps, SCOPE, "host-1", 10_000)

		expect(leased.kind).toBe("leased")
		if (leased.kind !== "leased") return
		expect(leased.host.id).toBe("host-1")
		leased.reader.release()
		expect(readConnections.activeLeases()).toBe(0)
	})

	it("C6: refuses a lease taken on a row read before a re-trust committed, before any command runs", async () => {
		const { deps, made, readConnections, expectedFingerprints } = harness((call) => {
			if (call === 1) {
				readConnections.evict(hostReadKey("org-1", "host-1"))
				return row({ hostKeyFingerprint: "SHA256:first" })
			}
			return row({ hostKeyFingerprint: "SHA256:second" })
		})

		const leased = await leaseHostReader(deps, SCOPE, "host-1", 10_000)

		expect(leased).toEqual({ kind: "changed" })
		expect(expectedFingerprints).toEqual(["SHA256:first"])
		expect(made[0]?.commands).toEqual([])
		expect(readConnections.activeLeases()).toBe(0)
	})

	it("C4: refuses a host whose removal was requested, without opening anything", async () => {
		const { deps, made } = harness(() => row({ teardownRequestedAt: new Date() }))

		await expect(leaseHostReader(deps, SCOPE, "host-1", 10_000)).resolves.toEqual({
			kind: "missing",
		})
		expect(made).toHaveLength(0)
	})

	it("C4: refuses a host whose removal was requested after it was read, and gives the lease back", async () => {
		const { deps, readConnections } = harness((call) =>
			call === 1 ? row() : row({ teardownRequestedAt: new Date() }),
		)

		await expect(leaseHostReader(deps, SCOPE, "host-1", 10_000)).resolves.toEqual({
			kind: "missing",
		})
		expect(readConnections.activeLeases()).toBe(0)
	})

	it("C5: never leases another organization's host, even by its exact id", async () => {
		const { deps, made, sshKeys } = harness(() => row())

		await expect(
			leaseHostReader(deps, { organizationId: "org-2" }, "host-1", 10_000),
		).resolves.toEqual({ kind: "missing" })
		expect(made).toHaveLength(0)
		expect(sshKeys.findById).not.toHaveBeenCalled()
	})

	it("tells a host that never finished provisioning apart from a missing one", async () => {
		const { deps, made } = harness(() => row({ osRelease: null }))

		await expect(leaseHostReader(deps, SCOPE, "host-1", 10_000)).resolves.toEqual({
			kind: "unprovisioned",
		})
		expect(made).toHaveLength(0)
	})

	it("calls a host whose SSH key is gone missing, and leaves no connection behind", async () => {
		const { deps, made } = harness(() => row(), { key: undefined })

		await expect(leaseHostReader(deps, SCOPE, "host-1", 10_000)).resolves.toEqual({
			kind: "missing",
		})
		expect(made[0]?.destroyCount()).toBe(1)
	})

	it("says a host could not be reached in fixed words that name no address", async () => {
		const { deps } = harness(() => row(), {
			connectFailure: new Error("connect EHOSTUNREACH 10.0.0.1:22"),
		})

		const failure = await leaseHostReader(deps, SCOPE, "host-1", 10_000).then(
			() => undefined,
			(error: Error) => error,
		)

		expect(failure).toBeInstanceOf(HostUnreachableError)
		expect(failure?.message).not.toContain("10.0.0.1")
	})
})
