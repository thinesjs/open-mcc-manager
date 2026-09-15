import type { HostRow, InstanceRow } from "@open-mcc/db"
import { createFakeTransport } from "@open-mcc/transport"
import { describe, expect, it, vi } from "vitest"
import type { OrgScope } from "../host/host.repository"
import { ARTIFACT_RETENTION_DAYS, ARTIFACTS_KEPT_PER_KIND, MAX_ARTIFACT_BYTES } from "./artifact"
import type { ArtifactValues } from "./artifact.repository"
import {
	type ArtifactCollectDeps,
	type ArtifactCollectRun,
	artifactCollectJob,
	artifactCollectReporter,
	createArtifactCollector,
} from "./artifact-collect.job"
import { instanceDir } from "./unit"

type FakeScript = NonNullable<Parameters<typeof createFakeTransport>[0]>

const NOW = new Date("2026-09-13T12:00:00.000Z")

const host: HostRow = {
	id: "host-1",
	organizationId: "org-1",
	name: "box",
	hostname: "10.4.5.6",
	port: 22,
	username: "mcc",
	status: "ready",
	networkStack: null,
	architecture: null,
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
	createdAt: NOW,
}

const DIRECTORY = instanceDir("afk")

const playerLogRead = `head -c ${MAX_ARTIFACT_BYTES} ${DIRECTORY}/'playerlog.txt' 2>/dev/null | base64 | tr -d '\\n'`

type Recorder = {
	stored: ArtifactValues[]
	keptBounds: Array<{ instanceId: string; kind: string; kept: number }>
	retention: Date[]
}

const depsFor = (
	script: FakeScript,
	overrides: Partial<ArtifactCollectDeps> = {},
): { deps: ArtifactCollectDeps; recorder: Recorder } => {
	const recorder: Recorder = { stored: [], keptBounds: [], retention: [] }
	const deps: ArtifactCollectDeps = {
		organizationIds: async () => ["org-1"],
		hosts: async () => [host],
		instancesOn: async () => [instance],
		savedDocument: async () => undefined,
		connect: async () => {
			const transport = createFakeTransport(script)
			await transport.connect({
				hostname: host.hostname,
				port: host.port,
				username: host.username,
				privateKey: "k",
				expectedFingerprint: "f",
				timeoutMs: 1,
			})
			return transport
		},
		store: async (_scope: OrgScope, values: ArtifactValues) => {
			recorder.stored.push(values)
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
	it("keeps what a host wrote and bounds what is kept for the kinds it collected", async () => {
		const { deps, recorder } = depsFor({
			[playerLogRead]: {
				stdout: Buffer.from("alice\n").toString("base64"),
				stderr: "",
				exitCode: 0,
			},
		})

		const run = await createArtifactCollector(deps)()

		expect(run.collected).toBe(1)
		expect(recorder.stored[0]?.kind).toBe("playerList")
		expect(recorder.stored[0]?.collectedAt).toEqual(NOW)
		expect(recorder.keptBounds).toEqual([
			{ instanceId: "afk", kind: "playerList", kept: ARTIFACTS_KEPT_PER_KIND },
		])
	})

	it("does not bound a kind it collected nothing of", async () => {
		const { deps, recorder } = depsFor({})

		await createArtifactCollector(deps)()

		expect(recorder.keptBounds).toEqual([])
	})

	it("ages stored artifacts out at the retention cutoff", async () => {
		const { deps, recorder } = depsFor({})

		const run = await createArtifactCollector(deps)()

		expect(recorder.retention).toEqual([
			new Date(NOW.getTime() - ARTIFACT_RETENTION_DAYS * 24 * 60 * 60 * 1000),
		])
		expect(run.storedPruned).toBe(2)
	})

	it("closes the connection even when the sweep threw", async () => {
		const closed: string[] = []
		const { deps } = depsFor(
			{},
			{
				connect: async () => {
					const transport = createFakeTransport({})
					await transport.connect({
						hostname: host.hostname,
						port: host.port,
						username: host.username,
						privateKey: "k",
						expectedFingerprint: "f",
						timeoutMs: 1,
					})
					return {
						...transport,
						close: async () => {
							closed.push(host.id)
						},
					}
				},
				instancesOn: async () => [{ ...instance, id: "not a valid instance id" }],
			},
		)

		const run = await createArtifactCollector(deps)()

		expect(run.unreachable).toBe(1)
		expect(closed).toEqual([host.id])
	})

	it("counts an unreachable host and carries no host address into the run", async () => {
		const onError = vi.fn()
		const { deps } = depsFor(
			{},
			{
				connect: async () => {
					throw new Error("ssh: connect to host 10.4.5.6 port 22: connection refused")
				},
				onError,
			},
		)

		const run = await createArtifactCollector(deps)()

		expect(run.unreachable).toBe(1)
		expect(run.collected).toBe(0)
		expect(onError).toHaveBeenCalled()
	})

	it("still ages stored artifacts out when every host is unreachable", async () => {
		const { deps, recorder } = depsFor(
			{},
			{
				connect: async () => {
					throw new Error("unreachable")
				},
			},
		)

		await createArtifactCollector(deps)()

		expect(recorder.retention).toHaveLength(1)
	})

	it("skips a host that is not ready to be reached", async () => {
		const connect = vi.fn()
		const { deps } = depsFor({}, { hosts: async () => [{ ...host, status: "error" }], connect })

		const run = await createArtifactCollector(deps)()

		expect(run.hosts).toBe(0)
		expect(connect).not.toHaveBeenCalled()
	})
})

describe("reporting a sweep", () => {
	const emptyRun: ArtifactCollectRun = {
		hosts: 1,
		unreachable: 0,
		collected: 0,
		oversize: 0,
		refused: 0,
		failed: 0,
		replaysPruned: 0,
		cacheDirectoriesPruned: 0,
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
