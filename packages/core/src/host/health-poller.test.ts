import type { HostRow, SshKeyRow } from "@open-mcc/db"
import {
	type ConnectOptions,
	createFakeTransport,
	createReadConnections,
	READ_CONNECTION_CHANNEL_LIMIT,
	READ_CONNECTION_HARD_AGE_MS,
	READ_CONNECTION_IDLE_MS,
	readerOver,
} from "@open-mcc/transport"
import { describe, expect, it, vi } from "vitest"
import { activeCheckCommand } from "../instance/reconcile"
import { OS_RELEASE_COMMAND } from "./facts"
import { failedUnitsCommand } from "./health"
import { isPollable, runHealthPoll } from "./health-poller"
import type { OrgScope } from "./host.repository"
import { type HostReadLease, leaseHostReader } from "./host-reader"

const host = (overrides: Partial<HostRow> = {}): HostRow => ({
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
	hostKeyFingerprint: "SHA256:x",
	hostKeyTrustedBy: null,
	hostKeyTrustedByLabel: "owner",
	hostKeyTrustedAt: null,
	status: "ready",
	osRelease: "systemd 252",
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

const NOTHING_FAILED = ""

const TWO_FAILED = [
	"open-mcc@one.service loaded failed failed one",
	"open-mcc@two.service loaded failed failed two",
].join("\n")

const hostScript = (failed: string, os = "debian\nDebian GNU/Linux 12") => ({
	[failedUnitsCommand()]: { stdout: failed, stderr: "", exitCode: 0 },
	[OS_RELEASE_COMMAND]: { stdout: os, stderr: "", exitCode: 0 },
})

const leasing =
	(failed: string, os?: string) =>
	async (target: HostRow): Promise<HostReadLease> => ({
		kind: "leased",
		reader: await readerOver(createFakeTransport(hostScript(failed, os))),
		host: target,
		identity: {
			hostname: target.hostname,
			port: target.port,
			username: target.username,
			sshKeyId: target.sshKeyId ?? "",
			hostKeyFingerprint: target.hostKeyFingerprint ?? "",
		},
	})

const unreachable = async (): Promise<HostReadLease> => {
	throw new Error("connection refused")
}

describe("keeping the panel's view of each host current", () => {
	it("reports an unreachable host to the recorder instead of only logging it", async () => {
		const recordReachability = vi.fn(async () => undefined)
		const now = new Date("2026-09-06T12:00:00Z")

		const run = await runHealthPoll({
			pollableHosts: async () => [host()],
			lease: unreachable,
			recordSeen: async () => undefined,
			recordReachability,
			now: () => now,
		})

		expect(run.unreachable).toEqual(["host-1"])
		expect(recordReachability).toHaveBeenCalledWith(
			expect.objectContaining({ id: "host-1" }),
			false,
		)
	})

	it("reports a reachable host to the recorder too, so uptime has both sides", async () => {
		const recordReachability = vi.fn(async () => undefined)
		const now = new Date("2026-09-06T12:00:00Z")

		await runHealthPoll({
			pollableHosts: async () => [host()],
			lease: leasing(NOTHING_FAILED),
			recordSeen: async () => undefined,
			recordReachability,
			now: () => now,
		})

		expect(recordReachability).toHaveBeenCalledWith(expect.objectContaining({ id: "host-1" }), true)
	})

	it("keeps polling the rest of the fleet when the recorder itself fails", async () => {
		const onError = vi.fn()
		const now = new Date("2026-09-06T12:00:00Z")

		const run = await runHealthPoll({
			pollableHosts: async () => [host()],
			lease: unreachable,
			recordSeen: async () => undefined,
			recordReachability: async () => {
				throw new Error("database is down")
			},
			now: () => now,
			onError,
		})

		expect(run.unreachable).toEqual(["host-1"])
		expect(onError).toHaveBeenCalledWith(
			expect.stringContaining("Could not record"),
			expect.anything(),
		)
	})

	it("records when a host answered, so staleness is measurable", async () => {
		const recordSeen = vi.fn(async () => undefined)
		const now = new Date("2026-09-06T12:00:00Z")

		const run = await runHealthPoll({
			pollableHosts: async () => [host()],
			lease: leasing(NOTHING_FAILED),
			recordSeen,
			now: () => now,
		})

		expect(run.reached).toEqual(["host-1"])
		expect(recordSeen).toHaveBeenCalledWith(
			expect.objectContaining({ id: "host-1" }),
			now,
			expect.objectContaining({ failedUnits: 0 }),
		)
	})

	it("records what has failed on the host, which is what makes it look abnormal", async () => {
		const recordSeen = vi.fn(async () => undefined)

		await runHealthPoll({
			pollableHosts: async () => [host()],
			lease: leasing(TWO_FAILED),
			recordSeen,
			now: () => new Date(),
		})

		expect(recordSeen).toHaveBeenCalledWith(
			expect.anything(),
			expect.anything(),
			expect.objectContaining({ failedUnits: 2 }),
		)
	})

	it("writes nothing when a host cannot be reached, so it ages into offline on its own", async () => {
		const recordSeen = vi.fn(async () => undefined)

		const run = await runHealthPoll({
			pollableHosts: async () => [host()],
			lease: unreachable,
			recordSeen,
			now: () => new Date(),
		})

		expect(run.unreachable).toEqual(["host-1"])
		expect(recordSeen).not.toHaveBeenCalled()
	})

	it("keeps polling the rest of the fleet after one host fails", async () => {
		const recordSeen = vi.fn(async () => undefined)
		const healthy = leasing(NOTHING_FAILED)

		const run = await runHealthPoll({
			pollableHosts: async () => [host({ id: "a" }), host({ id: "b" })],
			lease: async (target) => (target.id === "a" ? await unreachable() : await healthy(target)),
			recordSeen,
			now: () => new Date(),
		})

		expect(run.unreachable).toEqual(["a"])
		expect(run.reached).toEqual(["b"])
	})

	it("re-reads which distribution the host runs, so a stale record corrects itself", async () => {
		const recordSeen = vi.fn(async () => undefined)

		await runHealthPoll({
			pollableHosts: async () => [host({ osId: "ubuntu", osName: "Ubuntu 24.04" })],
			lease: leasing(NOTHING_FAILED),
			recordSeen,
			now: () => new Date(),
		})

		expect(recordSeen).toHaveBeenCalledWith(
			expect.anything(),
			expect.anything(),
			expect.objectContaining({ osId: "debian" }),
		)
	})

	it.each(["ready", "error", "provisioning", "unreachable"] as const)(
		"keeps polling a set-up host whose status is %s, so a failed or running Repair freezes nothing",
		(status) => {
			expect(isPollable(host({ status }))).toBe(true)
		},
	)

	it("polls a host whose Repair failed, leasing it like any other", async () => {
		const lease = vi.fn(leasing(NOTHING_FAILED))

		const run = await runHealthPoll({
			pollableHosts: async () => [host({ status: "error" })],
			lease,
			recordSeen: async () => undefined,
			now: () => new Date(),
		})

		expect(run.reached).toEqual(["host-1"])
		expect(lease).toHaveBeenCalledTimes(1)
	})

	it("never polls a host that never finished setup, whatever its status says", () => {
		expect(isPollable(host({ status: "pending", osRelease: null }))).toBe(false)
		expect(isPollable(host({ status: "provisioning", osRelease: null }))).toBe(false)
		expect(isPollable(host({ osRelease: null }))).toBe(false)
	})

	it("never polls a host being removed, which teardown is emptying", () => {
		expect(isPollable(host({ status: "removing" }))).toBe(false)
	})

	it.each([
		["network stack", { networkStack: null }],
		["architecture", { architecture: null }],
	] as const)(
		"never polls a ready host with no %s recorded, and never leases it",
		async (_field, missing) => {
			const lease = vi.fn(leasing(NOTHING_FAILED))

			const run = await runHealthPoll({
				pollableHosts: async () => [host(missing)],
				lease,
				recordSeen: async () => undefined,
				now: () => new Date(),
			})

			expect(isPollable(host(missing))).toBe(false)
			expect(run).toEqual({ polled: 0, reached: [], unreachable: [] })
			expect(lease).not.toHaveBeenCalled()
		},
	)

	it("polls a ready host with both its network stack and architecture recorded", () => {
		expect(isPollable(host({ networkStack: "pasta", architecture: "arm64" }))).toBe(true)
	})

	it("gives back every lease it takes, including when the write after it fails", async () => {
		const released: string[] = []
		const healthy = leasing(NOTHING_FAILED)

		await runHealthPoll({
			pollableHosts: async () => [host()],
			lease: async (target) => {
				const leased = await healthy(target)
				if (leased.kind !== "leased") return leased
				const release = leased.reader.release
				return {
					...leased,
					reader: {
						...leased.reader,
						release: () => {
							released.push("released")
							release()
						},
					},
				}
			},
			recordSeen: async () => {
				throw new Error("write failed")
			},
			now: () => new Date(),
		})

		expect(released).toEqual(["released"])
	})

	it("skips a host whose row is gone or changed by the time it leases, without calling it unreachable", async () => {
		const recordReachability = vi.fn(async () => undefined)

		const run = await runHealthPoll({
			pollableHosts: async () => [host()],
			lease: async () => ({ kind: "changed" }),
			recordSeen: async () => undefined,
			recordReachability,
			now: () => new Date(),
		})

		expect(run).toEqual({ polled: 1, reached: [], unreachable: [] })
		expect(recordReachability).not.toHaveBeenCalled()
	})
})

describe("the health poller on a shared connection", () => {
	const keyRow: SshKeyRow = {
		id: "key-1",
		organizationId: "org-1",
		name: "key-1",
		publicKey: "ssh-ed25519 AAAA",
		privateKeyEncrypted: "sealed",
		privateKeyKeyId: "k1",
		createdAt: new Date(),
	}

	const wired = (scoped: HostRow) => {
		const expectedFingerprints: string[] = []
		const readConnections = createReadConnections({
			createTransport: () => {
				const transport = createFakeTransport(hostScript(NOTHING_FAILED))
				return {
					...transport,
					connect: async (options: ConnectOptions) => {
						expectedFingerprints.push(options.expectedFingerprint)
						await transport.connect(options)
					},
				}
			},
			idleMs: READ_CONNECTION_IDLE_MS,
			hardAgeMs: READ_CONNECTION_HARD_AGE_MS,
			channelLimit: READ_CONNECTION_CHANNEL_LIMIT,
			now: () => Date.now(),
		})
		const readerDeps = {
			hosts: {
				findById: vi.fn(async (scope: OrgScope, id: string) =>
					scope.organizationId === scoped.organizationId && id === scoped.id ? scoped : undefined,
				),
			},
			sshKeys: { findById: vi.fn(async () => keyRow) },
			secrets: { open: () => "PRIVATE KEY" },
			readConnections,
		}
		const lease = (target: HostRow, deadlineMs: number) =>
			leaseHostReader(
				readerDeps,
				{ organizationId: target.organizationId },
				target.id,
				deadlineMs,
				"runtime",
			)
		return { readConnections, lease, expectedFingerprints }
	}

	it("C6: connects on the trust the scoped row holds now, never on the fleet list's older copy", async () => {
		const { lease, expectedFingerprints } = wired(host({ hostKeyFingerprint: "SHA256:second" }))
		const recordSeen = vi.fn(async () => undefined)

		const run = await runHealthPoll({
			pollableHosts: async () => [host({ hostKeyFingerprint: "SHA256:first" })],
			lease,
			recordSeen,
			now: () => new Date(),
		})

		expect(run.reached).toEqual(["host-1"])
		expect(expectedFingerprints).toEqual(["SHA256:second"])
		expect(recordSeen).toHaveBeenCalledWith(
			expect.objectContaining({ hostKeyFingerprint: "SHA256:second" }),
			expect.anything(),
			expect.anything(),
		)
	})

	it("C7: holds no lease while its database write is still pending", async () => {
		const { readConnections, lease } = wired(host())
		let finishWrite: () => void = () => undefined
		const writing = new Promise<void>((resolve) => {
			finishWrite = resolve
		})
		let leasesDuringWrite = -1
		let writeStarted: () => void = () => undefined
		const started = new Promise<void>((resolve) => {
			writeStarted = resolve
		})

		const polling = runHealthPoll({
			pollableHosts: async () => [host()],
			lease,
			recordSeen: async () => {
				leasesDuringWrite = readConnections.activeLeases()
				writeStarted()
				await writing
			},
			now: () => new Date(),
		})
		await started

		expect(leasesDuringWrite).toBe(0)
		expect(readConnections.activeLeases()).toBe(0)
		finishWrite()
		await expect(polling).resolves.toMatchObject({ reached: ["host-1"] })
	})

	it("C7: gives each bot's read its own lease, and gives it back before recording anything", async () => {
		const { readConnections, lease } = wired(host())
		const leasesAtEachWrite: number[] = []

		await runHealthPoll({
			pollableHosts: async () => [host()],
			lease,
			recordSeen: async () => {
				leasesAtEachWrite.push(readConnections.activeLeases())
			},
			observeInstances: async (_target, leaseForRead) => {
				for (const instanceId of ["abc123", "def456"]) {
					const leased = await leaseForRead(20_000)
					if (leased.kind !== "leased") return
					try {
						await leased.reader.exec(activeCheckCommand(instanceId))
					} finally {
						leased.reader.release()
					}
					leasesAtEachWrite.push(readConnections.activeLeases())
					expect(instanceId).toMatch(/^[a-z0-9]+$/)
				}
			},
			now: () => new Date(),
		})

		expect(leasesAtEachWrite).toEqual([0, 0, 0])
	})
})
