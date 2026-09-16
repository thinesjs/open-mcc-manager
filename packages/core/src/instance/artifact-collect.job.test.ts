import type { HostRow, InstanceRow } from "@open-mcc/db"
import type { ReusableTransport } from "@open-mcc/transport"
import { describe, expect, it, vi } from "vitest"
import type { OrgScope } from "../host/host.repository"
import { createPlayerListHost, fingerprintOf, type PlayerListHost } from "../test/player-list-host"
import {
	ARTIFACT_RETENTION_DAYS,
	ARTIFACTS_KEPT_PER_KIND,
	type CursorAdvance,
	EMPTY_FINGERPRINT,
	PLAYER_LIST_FILE_DEFAULT,
} from "./artifact"
import type { ArtifactValues } from "./artifact.repository"
import {
	type ArtifactCollectDeps,
	type ArtifactCollectRun,
	artifactCollectJob,
	artifactCollectReporter,
	createArtifactCollector,
} from "./artifact-collect.job"

const NOW = new Date("2026-09-13T12:00:00.000Z")

const host: HostRow = {
	id: "host-1",
	organizationId: "org-1",
	name: "box",
	hostname: "10.4.5.6",
	port: 22,
	username: "mcc",
	status: "ready",
	networkStack: "slirp4netns",
	architecture: "x64",
	sshKeyId: "key-1",
	hostKeyFingerprint: "SHA256:abc",
	hostKeyAlgorithm: "ssh-ed25519",
	hostKeyTrustedAt: NOW,
	hostKeyTrustedBy: null,
	hostKeyTrustedByLabel: "someone",
	createdAt: NOW,
	lastSeenAt: NOW,
	cpuCount: null,
	memoryMb: null,
	osId: null,
	osName: null,
	osRelease: "systemd 252",
	failedUnits: null,
	provisioningAttemptId: null,
	provisioningClaimedAt: null,
	provisioningError: null,
	provisioningStep: null,
	provisioningStepIndex: null,
	provisioningStepTotal: null,
	teardownError: null,
	teardownRequestedAt: null,
}

const instance: InstanceRow = {
	id: "afk",
	organizationId: "org-1",
	hostId: "host-1",
	name: "afk",
	minecraftAccount: "a@b.com",
	minecraftUsername: null,
	accountType: "microsoft",
	status: "running",
	lastExitCode: null,
	liveControlPort: 34333,
	liveControlTokenEncrypted: null,
	liveControlTokenKeyId: null,
	authClaimId: null,
	authClaimedAt: null,
	configClaimId: null,
	configClaimedAt: null,
	playerListOffset: "0",
	playerListFingerprint: EMPTY_FINGERPRINT,
	playerListCursorVersion: "0",
	createdAt: NOW,
}

type Recorder = {
	stored: ArtifactValues[]
	advances: CursorAdvance[]
	resets: number[]
	keptBounds: Array<{ instanceId: string; kind: string; kept: number }>
	retention: Date[]
}

const playerListHost = (content: string | undefined, unit = "active", auth = "inactive") =>
	createPlayerListHost("afk", PLAYER_LIST_FILE_DEFAULT, {
		content: content === undefined ? undefined : Buffer.from(content),
		unit,
		auth,
	})

const connected = async (transport: ReusableTransport): Promise<ReusableTransport> => {
	await transport.connect({
		hostname: host.hostname,
		port: host.port,
		username: host.username,
		privateKey: "k",
		expectedFingerprint: "f",
		timeoutMs: 1,
	})
	return transport
}

const depsFor = (
	target: PlayerListHost = playerListHost(undefined),
	overrides: Partial<ArtifactCollectDeps> = {},
): { deps: ArtifactCollectDeps; recorder: Recorder } => {
	const recorder: Recorder = {
		stored: [],
		advances: [],
		resets: [],
		keptBounds: [],
		retention: [],
	}
	const deps: ArtifactCollectDeps = {
		organizationIds: async () => ["org-1"],
		hosts: async () => [host],
		host: async () => host,
		instancesOn: async () => [instance],
		savedDocument: async () => undefined,
		connect: async () => await connected(target.transport),
		store: async (_scope: OrgScope, values: ArtifactValues) => {
			recorder.stored.push(values)
			return true
		},
		storeAndAdvance: async (_scope, values, advance) => {
			recorder.stored.push(values)
			recorder.advances.push(advance)
		},
		resetCursor: async (_scope, _instanceId, version) => {
			recorder.resets.push(version)
			return true
		},
		deleteBeyondKept: async (_scope, instanceId, kind, kept) => {
			recorder.keptBounds.push({ instanceId, kind, kept })
			return 1
		},
		deleteCollectedBefore: async (_scope, cutoff) => {
			recorder.retention.push(cutoff)
			return 2
		},
		now: () => NOW,
		...overrides,
	}
	return { deps, recorder }
}

describe("collecting across the fleet", () => {
	it("keeps what a host wrote, advances its cursor, and bounds what is kept for the kinds it collected", async () => {
		const { deps, recorder } = depsFor(playerListHost("alice\n"))

		const run = await createArtifactCollector(deps)()

		expect(run.collected).toBe(1)
		expect(recorder.stored[0]?.kind).toBe("playerList")
		expect(recorder.stored[0]?.collectedAt).toEqual(NOW)
		expect(recorder.advances).toEqual([
			{ offset: 0, fingerprint: fingerprintOf(Buffer.from("alice\n"), 6), version: 0 },
		])
		expect(recorder.keptBounds).toEqual([
			{ instanceId: "afk", kind: "playerList", kept: ARTIFACTS_KEPT_PER_KIND },
		])
	})

	it("★ runs no host command while a commit is open: read, then commit, then truncate, then reset", async () => {
		const target = playerListHost("alice\n", "inactive", "inactive")
		const events: string[] = []
		const reach = target.transport.exec
		target.transport.exec = async (command: string, timeoutMs: number, stdin?: string) => {
			if (command.startsWith("s=$(find")) events.push("read")
			if (command.startsWith("timeout -k")) events.push("truncate")
			return await reach(command, timeoutMs, stdin)
		}
		const { deps } = depsFor(target, {
			storeAndAdvance: async () => {
				events.push("commit begins")
				await new Promise((resolve) => setTimeout(resolve, 5))
				events.push("commit ends")
			},
			resetCursor: async () => {
				events.push("reset")
				return true
			},
		})

		await createArtifactCollector(deps)()

		expect(events).toEqual(["read", "commit begins", "commit ends", "truncate", "reset"])
	})

	it("★ touches the host no more once its removal is requested mid-sweep: no truncate, no replay, no Mailer, no next bot", async () => {
		const target = playerListHost("alice\n", "inactive", "inactive")
		let teardownRequestedAt: Date | null = null
		let commandsBeforeRemoval = -1
		const { deps } = depsFor(target, {
			instancesOn: async () => [instance, { ...instance, id: "afk2" }],
			host: async () => ({ ...host, teardownRequestedAt }),
			storeAndAdvance: async () => {
				teardownRequestedAt = NOW
				commandsBeforeRemoval = target.transport.commands.length
			},
		})

		await createArtifactCollector(deps)()

		expect(commandsBeforeRemoval).toBe(1)
		expect(target.transport.commands).toHaveLength(commandsBeforeRemoval)
		expect(target.truncations()).toBe(0)
	})

	it("does not bound a kind it collected nothing of", async () => {
		const { deps, recorder } = depsFor()

		await createArtifactCollector(deps)()

		expect(recorder.keptBounds).toEqual([])
	})

	it("ages stored artifacts out at the retention cutoff", async () => {
		const { deps, recorder } = depsFor()

		const run = await createArtifactCollector(deps)()

		expect(recorder.retention).toEqual([
			new Date(NOW.getTime() - ARTIFACT_RETENTION_DAYS * 24 * 60 * 60 * 1000),
		])
		expect(run.storedPruned).toBe(2)
	})

	it("closes the connection even when the sweep threw", async () => {
		const closed: string[] = []
		const target = playerListHost(undefined)
		const { deps } = depsFor(target, {
			connect: async () => ({
				...(await connected(target.transport)),
				close: async () => {
					closed.push(host.id)
				},
			}),
			instancesOn: async () => [{ ...instance, id: "not a valid instance id" }],
		})

		const run = await createArtifactCollector(deps)()

		expect(run.unreachable).toBe(1)
		expect(closed).toEqual([host.id])
	})

	it("counts an unreachable host and carries no host address into the run", async () => {
		const onError = vi.fn()
		const { deps } = depsFor(undefined, {
			connect: async () => {
				throw new Error("ssh: connect to host 10.4.5.6 port 22: connection refused")
			},
			onError,
		})

		const run = await createArtifactCollector(deps)()

		expect(run.unreachable).toBe(1)
		expect(run.collected).toBe(0)
		expect(onError).toHaveBeenCalled()
	})

	it("still ages stored artifacts out when every host is unreachable", async () => {
		const { deps, recorder } = depsFor(undefined, {
			connect: async () => {
				throw new Error("unreachable")
			},
		})

		await createArtifactCollector(deps)()

		expect(recorder.retention).toHaveLength(1)
	})

	it.each([
		["being removed", { status: "removing" }],
		["that never finished setup", { status: "pending", osRelease: null }],
	] as const)("skips a host %s, and opens no connection to it", async (_case, state) => {
		const connect = vi.fn()
		const { deps } = depsFor(undefined, { hosts: async () => [{ ...host, ...state }], connect })

		const run = await createArtifactCollector(deps)()

		expect(run.hosts).toBe(0)
		expect(connect).not.toHaveBeenCalled()
	})

	it("★ names the bots a sweep could not finish and no others, so the run is not a bare count", async () => {
		const { deps } = depsFor(playerListHost("alice\n"), {
			instancesOn: async () => [instance, { ...instance, id: "spawn", playerListOffset: "bad" }],
			storeAndAdvance: async () => {
				throw new Error("the cursor moved")
			},
		})

		const run = await createArtifactCollector(deps)()

		expect({ failed: run.failed, refused: run.refused, named: run.failedInstanceIds }).toEqual({
			failed: 1,
			refused: 1,
			named: ["afk"],
		})
	})

	it("keeps collecting from a set-up host whose Repair failed", async () => {
		const { deps } = depsFor(undefined, { hosts: async () => [{ ...host, status: "error" }] })

		const run = await createArtifactCollector(deps)()

		expect(run.hosts).toBe(1)
		expect(run.unreachable).toBe(0)
	})

	it.each([
		["network stack", { networkStack: null }],
		["architecture", { architecture: null }],
	] as const)(
		"never sweeps a ready host with no %s recorded, and opens no connection to it",
		async (_field, missing) => {
			const connect = vi.fn()
			const { deps } = depsFor(undefined, {
				hosts: async () => [{ ...host, ...missing }],
				connect,
			})

			const run = await createArtifactCollector(deps)()

			expect(run.hosts).toBe(0)
			expect(connect).not.toHaveBeenCalled()
		},
	)
})

describe("reporting a sweep", () => {
	const emptyRun: ArtifactCollectRun = {
		hosts: 1,
		unreachable: 0,
		collected: 0,
		oversize: 0,
		refused: 0,
		failed: 0,
		failedInstanceIds: [],
		replaysPruned: 0,
		storedPruned: 0,
		mailerStateOverBudget: 0,
	}

	it("says nothing when a sweep found nothing", () => {
		const logger = { info: vi.fn(), warn: vi.fn() }
		artifactCollectReporter(logger)(emptyRun)
		expect(logger.info).not.toHaveBeenCalled()
		expect(logger.warn).not.toHaveBeenCalled()
	})

	it("warns that Mailer state is past what the control plane can do anything about", () => {
		const logger = { info: vi.fn(), warn: vi.fn() }
		artifactCollectReporter(logger)({ ...emptyRun, mailerStateOverBudget: 2 })
		expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("Mailer state"))
	})

	it("warns about what it had to leave behind", () => {
		const logger = { info: vi.fn(), warn: vi.fn() }
		artifactCollectReporter(logger)({ ...emptyRun, oversize: 1 })
		expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("too large"))
		expect(logger.warn).not.toHaveBeenCalledWith(expect.stringContaining(" on "))
	})

	it("★ names the bots it left uncollected, rather than only how many", () => {
		const logger = { info: vi.fn(), warn: vi.fn() }
		artifactCollectReporter(logger)({
			...emptyRun,
			failed: 2,
			failedInstanceIds: ["afk", "spawn"],
		})
		expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("2 uncollected on afk, spawn"))
	})

	it("reports the run the collector returned", async () => {
		const logger = { info: vi.fn(), warn: vi.fn() }
		await artifactCollectJob(
			async () => ({ ...emptyRun, collected: 3 }),
			artifactCollectReporter(logger),
		)()
		expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("3"))
	})
})
