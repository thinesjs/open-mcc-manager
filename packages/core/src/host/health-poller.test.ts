import type { HostRow } from "@open-mcc/db"
import { createFakeTransport } from "@open-mcc/transport"
import { describe, expect, it, vi } from "vitest"
import { OS_RELEASE_COMMAND } from "./facts"
import { failedUnitsCommand } from "./health"
import { isPollable, runHealthPoll } from "./health-poller"
import { systemProfile } from "./profile"

const host = (overrides: Partial<HostRow> = {}): HostRow => ({
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
	sshKeyId: "key-1",
	hostKeyAlgorithm: "ssh-ed25519",
	hostKeyFingerprint: "SHA256:x",
	hostKeyTrustedBy: null,
	hostKeyTrustedByLabel: "owner",
	hostKeyTrustedAt: null,
	status: "ready",
	osRelease: null,
	cpuCount: null,
	memoryMb: null,
	capacityLimit: null,
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

const connectedTransport =
	(failed: string, os = "debian\nDebian GNU/Linux 12") =>
	async () => {
		const transport = createFakeTransport({
			[failedUnitsCommand(systemProfile())]: { stdout: failed, stderr: "", exitCode: 0 },
			[OS_RELEASE_COMMAND]: { stdout: os, stderr: "", exitCode: 0 },
		})
		await transport.connect({
			hostname: "h",
			port: 22,
			username: "u",
			privateKey: "k",
			expectedFingerprint: "f",
			timeoutMs: 1000,
		})
		return transport
	}

describe("keeping the panel's view of each host current", () => {
	it("records when a host answered, so staleness is measurable", async () => {
		const recordSeen = vi.fn(async () => undefined)
		const now = new Date("2026-09-06T12:00:00Z")

		const run = await runHealthPoll({
			pollableHosts: async () => [host()],
			connect: connectedTransport("0"),
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
			connect: connectedTransport("2"),
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
			connect: async () => {
				throw new Error("connection refused")
			},
			recordSeen,
			now: () => new Date(),
		})

		expect(run.unreachable).toEqual(["host-1"])
		expect(recordSeen).not.toHaveBeenCalled()
	})

	it("keeps polling the rest of the fleet after one host fails", async () => {
		const recordSeen = vi.fn(async () => undefined)
		let attempt = 0

		const run = await runHealthPoll({
			pollableHosts: async () => [host({ id: "a" }), host({ id: "b" })],
			connect: async (target) => {
				attempt += 1
				if (attempt === 1) throw new Error("down")
				return connectedTransport("0")().then((t) => {
					expect(target.id).toBe("b")
					return t
				})
			},
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
			connect: connectedTransport("0"),
			recordSeen,
			now: () => new Date(),
		})

		expect(recordSeen).toHaveBeenCalledWith(
			expect.anything(),
			expect.anything(),
			expect.objectContaining({ osId: "debian" }),
		)
	})

	it("polls only hosts that finished provisioning", () => {
		expect(isPollable(host())).toBe(true)
		expect(isPollable(host({ status: "pending" }))).toBe(false)
		expect(isPollable(host({ status: "provisioning" }))).toBe(false)
		expect(isPollable(host({ instancesRoot: null }))).toBe(false)
	})

	it("closes every connection it opens, including on failure", async () => {
		const closed: string[] = []
		const transport = await connectedTransport("0")()
		const spy = vi.spyOn(transport, "close").mockImplementation(async () => {
			closed.push("closed")
		})

		await runHealthPoll({
			pollableHosts: async () => [host()],
			connect: async () => transport,
			recordSeen: async () => {
				throw new Error("write failed")
			},
			now: () => new Date(),
		})

		expect(spy).toHaveBeenCalled()
		expect(closed).toHaveLength(1)
	})
})
