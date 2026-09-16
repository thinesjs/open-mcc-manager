import {
	type ArtifactCollectDeps,
	createArtifactCollector,
	createLogger,
	generateKeyPair,
} from "@open-mcc/core"
import type { HostRow, InstanceConfigRow, InstanceRow, Json } from "@open-mcc/db"
import { createFakeTransport } from "@open-mcc/transport"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { WorkerEnv } from "./env"

const state = vi.hoisted(() => {
	const held: { document: Json; deps: ArtifactCollectDeps | undefined } = {
		document: {},
		deps: undefined,
	}
	return held
})

vi.mock("@open-mcc/core", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@open-mcc/core")>()
	return {
		...actual,
		createInstanceRepository: (...args: Parameters<typeof actual.createInstanceRepository>) => ({
			...actual.createInstanceRepository(...args),
			latestConfig: async (): Promise<InstanceConfigRow> => ({
				id: "cfg-1",
				organizationId: "org-1",
				instanceId: "afk",
				version: 1,
				document: state.document,
				authorId: null,
				authorLabel: "someone",
				createdAt: new Date(),
			}),
		}),
		createArtifactCollector: (deps: ArtifactCollectDeps) => {
			state.deps = deps
			return actual.createArtifactCollector(deps)
		},
	}
})

const NOW = new Date("2026-09-14T12:00:00.000Z")

const HOST: HostRow = {
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

const INSTANCE: InstanceRow = {
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
	playerListFingerprint: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
	playerListCursorVersion: "0",
	createdAt: NOW,
}

const SETTINGS = {
	accountType: "microsoft",
	minecraftAccount: "a@b.com",
	serverAddress: "play.example.net",
	autoRelogRetries: 3,
	autoRelogEnabled: true,
	autoRelogDelaySeconds: { min: 10, max: 10 },
	antiAfkEnabled: false,
	antiAfkIntervalSeconds: { min: 60, max: 60 },
	autoRespawnEnabled: false,
	liveControlEnabled: false,
	liveControlPort: 34333,
	worldDataEnabled: false,
	inventoryDataEnabled: false,
	entityDataEnabled: false,
	advancedKeys: {},
}

const env = async (): Promise<WorkerEnv> => ({
	DATABASE_URL: process.env.TEST_DATABASE_URL ?? "",
	SEALBOX_KEYS: await generateKeyPair("k1"),
	STATUS_RETENTION_DAYS: 30,
	NOTIFICATION_ALLOW_HTTP: false,
	NOTIFICATION_ALLOWED_HOSTS: "",
	NOTIFICATION_ALLOWED_ADDRESSES: "",
	OTEL_EXPORTER_OTLP_ENDPOINT: "",
})

let stop: (() => Promise<void>) | undefined

afterEach(async () => {
	if (stop) await stop()
	stop = undefined
})

const commandsSweptWith = async (botConfig: Json): Promise<readonly string[]> => {
	state.document = { ...SETTINGS, botConfig }
	const { startWorker } = await import("./bootstrap")
	const handle = await startWorker(
		await env(),
		createLogger({ level: "error", write: () => undefined }),
	)
	stop = async () => await handle.stop()
	const wired = state.deps
	if (wired === undefined) throw new Error("the worker never built its artifact collector")
	const transport = createFakeTransport()
	await createArtifactCollector({
		...wired,
		organizationIds: async () => ["org-1"],
		hosts: async () => [HOST],
		host: async () => HOST,
		instancesOn: async () => [INSTANCE],
		connect: async () => {
			await transport.connect({
				hostname: HOST.hostname,
				port: HOST.port,
				username: HOST.username,
				privateKey: "k",
				expectedFingerprint: "f",
				timeoutMs: 1,
			})
			return transport
		},
		store: async () => true,
		storeAndAdvance: async () => undefined,
		resetCursor: async () => true,
		deleteBeyondKept: async () => 0,
		deleteCollectedBefore: async () => 0,
	})()
	return transport.commands
}

const readsPlayerList = (commands: readonly string[], name: string): boolean =>
	commands.some((command) => command.startsWith("s=$(find") && command.includes(`/state/'${name}'`))

describe("★ the file names the worker hands its artifact collector", () => {
	it("reads the operator's own player list from a stored config the repository returns as an object", async () => {
		const commands = await commandsSweptWith({ "ChatBot.PlayerListLogger.File": "roster.txt" })

		expect(readsPlayerList(commands, "roster.txt")).toBe(true)
		expect(readsPlayerList(commands, "playerlog.txt")).toBe(false)
	})

	it("never reads a Mailer database named playerlog.txt as the player list", async () => {
		const commands = await commandsSweptWith({ "ChatBot.Mailer.DatabaseFile": "playerlog.txt" })

		expect(readsPlayerList(commands, "playerlog.txt")).toBe(false)
		expect(
			commands.some(
				(command) => command.startsWith("stat -c") && command.includes("/state/'playerlog.txt'"),
			),
		).toBe(true)
	})
})
