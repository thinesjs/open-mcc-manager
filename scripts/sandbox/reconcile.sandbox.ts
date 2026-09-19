import { PassThrough } from "node:stream"
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"
import { createSecretStore, generateKeyPair } from "../../packages/core/src/crypto/sealed-box"
import { hostReadKey } from "../../packages/core/src/host/host-reader"
import { architectureForMachine } from "../../packages/core/src/host/mcc-release"
import {
	parsePodmanVersion,
	requiredStackFor,
	storageStepCommand,
} from "../../packages/core/src/host/podman-facts"
import { RUNTIME_IMAGE_REPOSITORY } from "../../packages/core/src/host/runtime-image"
import {
	type ActorContext,
	createInstanceController,
	type InstanceControllerDeps,
} from "../../packages/core/src/instance/instance.controller"
import type { HostRow, InstanceConfigRow, InstanceRow } from "../../packages/db/src/index"
import {
	createReadConnections,
	READ_CONNECTION_CHANNEL_LIMIT,
	READ_CONNECTION_HARD_AGE_MS,
	READ_CONNECTION_IDLE_MS,
} from "../../packages/transport/src/read-connections"
import { LiveChannelUnavailableError } from "../../packages/transport/src/types"
import {
	ACCOUNT,
	PODMAN_TARGETS,
	shellTransport,
	startPodmanHost,
	withUserManager,
} from "./podman-account"
import {
	type As,
	exec,
	mintKey,
	ROOT,
	remove,
	SSH_CLIENT,
	seedAuthorizedKeys,
	shell,
	succeeded,
} from "./sandbox"

const BUSYBOX = "docker.io/library/busybox:1.36.1"

const ORGANIZATION = "org-reconcile"

const HOST_ID = "host-reconcile"

const KNOWN = "known1"

const STRAY = "open-mcc-stray1"

const STRAY_PORT = 34101

const LIVE = "live1"

const LIVE_PORT = 34102

const UNPUBLISHED_PORT = 34103

const TOKEN = "31337a0b1c2d3e4f5a6b7c8d9e0f3133"

const NETWORK = {
	slirp4netns: "slirp4netns:port_handler=slirp4netns",
	pasta: "pasta",
} as const

const STAND_IN_UNIT = "[Service]\nType=simple\nExecStart=/bin/sleep infinity\n"

const owner: ActorContext = {
	organizationId: ORGANIZATION,
	memberId: "member-reconcile",
	actorLabel: "sandbox@example.com",
	role: "owner",
}

const SAVED = {
	accountType: "offline",
	minecraftAccount: "SandboxBot",
	serverAddress: "127.0.0.1",
	autoRelogRetries: 3,
	autoRelogEnabled: true,
	autoRelogDelaySeconds: { min: 10, max: 10 },
	antiAfkEnabled: false,
	antiAfkIntervalSeconds: { min: 60, max: 60 },
	autoRespawnEnabled: false,
	liveControlEnabled: true,
	liveControlPort: LIVE_PORT,
	worldDataEnabled: false,
	inventoryDataEnabled: false,
	entityDataEnabled: false,
	advancedKeys: {},
	botConfig: {},
}

const instanceRow = (id: string, overrides: Partial<InstanceRow>): InstanceRow => ({
	id,
	organizationId: ORGANIZATION,
	hostId: HOST_ID,
	name: id,
	accountType: "offline",
	minecraftAccount: "SandboxBot",
	minecraftUsername: null,
	status: "stopped",
	lastExitCode: null,
	liveControlPort: 34100,
	liveControlTokenEncrypted: null,
	liveControlTokenKeyId: null,
	authClaimId: null,
	authClaimedAt: null,
	configClaimId: null,
	configClaimedAt: null,
	playerListOffset: "0",
	playerListFingerprint: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
	playerListCursorVersion: "0",
	createdAt: new Date(),
	...overrides,
})

const managerFor = async (
	host: string,
	as: As,
	architecture: ReturnType<typeof architectureForMachine>,
) => {
	const secrets = await createSecretStore(await generateKeyPair("sandbox"))
	const sealedKey = secrets.seal("a key the sandbox's shell transport never presents")
	const sealedToken = secrets.seal(TOKEN)
	const clock = { at: Date.now() }
	const opened: number[] = []
	const sent: string[] = []

	const hostRow: HostRow = {
		id: HOST_ID,
		organizationId: ORGANIZATION,
		name: "sandbox",
		hostname: "127.0.0.1",
		port: 22,
		username: ACCOUNT,
		networkStack: "slirp4netns",
		architecture,
		osId: null,
		osName: null,
		failedUnits: null,
		teardownError: null,
		teardownRequestedAt: null,
		sshKeyId: "key-sandbox",
		hostKeyAlgorithm: "ssh-ed25519",
		hostKeyFingerprint: "SHA256:sandbox",
		hostKeyTrustedBy: null,
		hostKeyTrustedByLabel: "sandbox",
		hostKeyTrustedAt: new Date(),
		status: "ready",
		osRelease: "systemd",
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
	}

	const rows = [
		instanceRow(KNOWN, {}),
		instanceRow(LIVE, {
			status: "running",
			liveControlPort: LIVE_PORT,
			liveControlTokenEncrypted: sealedToken.ciphertext,
			liveControlTokenKeyId: sealedToken.keyId,
		}),
	]

	const saved: InstanceConfigRow = {
		id: "config-live",
		organizationId: ORGANIZATION,
		instanceId: LIVE,
		version: 1,
		document: SAVED,
		authorId: null,
		authorLabel: "sandbox@example.com",
		createdAt: new Date(),
	}

	const refuse = async () => {
		throw new Error("the reconcile sandbox never writes to the store")
	}

	const recording = () => {
		const transport = shellTransport(host, as)
		const open = async (port: number) => {
			opened.push(port)
			const socket = new PassThrough()
			socket.on("data", (chunk) => {
				sent.push(String(chunk))
				socket.destroy()
			})
			return { socket, close: () => socket.destroy() }
		}
		transport.forwardUntil = open
		transport.forward = open
		return transport
	}

	const readConnections = createReadConnections({
		createTransport: recording,
		idleMs: READ_CONNECTION_IDLE_MS,
		hardAgeMs: READ_CONNECTION_HARD_AGE_MS,
		channelLimit: READ_CONNECTION_CHANNEL_LIMIT,
		now: () => Date.now(),
	})

	const deps: InstanceControllerDeps = {
		instances: {
			findById: async (_scope, id) => rows.find((row) => row.id === id),
			list: async () => rows,
			latestConfig: async (_scope, instanceId) => (instanceId === LIVE ? saved : undefined),
			insert: refuse,
			update: refuse,
			delete: refuse,
			claimForAuth: refuse,
			releaseAuthClaim: refuse,
			claimForConfig: refuse,
			claimForLifecycle: refuse,
			finalizeConfigClaim: refuse,
			releaseConfigClaim: refuse,
			writeTokenUnderClaim: refuse,
			deleteUnderClaim: refuse,
			insertConfigVersion: refuse,
		},
		schedules: {
			list: async () => [],
			findByInstance: async () => undefined,
			upsert: refuse,
			delete: refuse,
		},
		commands: {
			upsert: refuse,
			listForInstance: refuse,
			listEnabledAcrossOrganizations: refuse,
			delete: refuse,
			deleteReturning: refuse,
			claimRun: refuse,
			recordRun: refuse,
		},
		hosts: { findById: async () => hostRow },
		sshKeys: {
			findById: async () => ({
				id: "key-sandbox",
				organizationId: ORGANIZATION,
				name: "sandbox",
				publicKey: "ssh-ed25519 AAAA",
				privateKeyEncrypted: sealedKey.ciphertext,
				privateKeyKeyId: sealedKey.keyId,
				createdAt: new Date(),
			}),
		},
		secrets,
		createTransport: recording,
		readConnections,
		withTransaction: refuse,
		now: () => clock.at,
	}

	return { controller: createInstanceController(deps), readConnections, clock, opened, sent }
}

type Manager = Awaited<ReturnType<typeof managerFor>>

describe.each(PODMAN_TARGETS)("checking a Podman host and reaching its bots on $name", (target) => {
	let host = ""
	let as: As = ROOT
	let manager: Manager | undefined

	const ready = (): Manager => {
		if (manager === undefined) throw new Error("the sandbox host was never prepared")
		return manager
	}

	const reconciled = async () => {
		const reconciliation = await ready().controller.reconcileHost(owner, HOST_ID)
		if (!reconciliation.reachable) {
			throw new Error(`the setup check could not read the host: ${reconciliation.reason}`)
		}
		return reconciliation
	}

	beforeAll(async () => {
		host = await startPodmanHost(inject("sandbox"), target)
		as = await withUserManager(host)
		const storage = await shell(host, as, storageStepCommand())
		expect(storage.stdout.trim(), storage.stderr).toBe("ready")
		succeeded(
			await shell(host, { ...as, timeoutMs: 600_000 }, 'podman pull --quiet "$1"', BUSYBOX),
			"pulling busybox",
		)
		succeeded(
			await shell(
				host,
				{ ...as, input: STAND_IN_UNIT },
				'mkdir -p "$HOME/.config/systemd/user" && cat > "$HOME/.config/systemd/user/open-mcc@.service" && systemctl --user daemon-reload',
			),
			"installing a stand-in bot unit",
		)
		succeeded(
			await shell(host, as, 'podman run --name "open-mcc-$1" "$2" true', KNOWN, BUSYBOX),
			"leaving a stopped container for a known bot",
		)
		succeeded(
			await shell(
				host,
				as,
				'podman run -d --name "$1" --network="$2" -p "127.0.0.1:$3:$3" "$4" sleep 3600',
				STRAY,
				NETWORK[target.stack],
				String(STRAY_PORT),
				BUSYBOX,
			),
			"running a stray container that publishes a port",
		)
		const machine = succeeded(await exec(host, ROOT, ["uname", "-m"]), "reading the machine")
		manager = await managerFor(host, as, architectureForMachine(machine))
	}, 2_400_000)

	afterAll(async () => {
		manager?.readConnections.evict(hostReadKey(ORGANIZATION, HOST_ID))
		await remove(host)
	}, 300_000)

	it("reports a container no instance owns, and not a known stopped bot's own, with the image missing", async () => {
		const names = succeeded(
			await shell(host, as, "podman ps -a --format '{{.Names}}'"),
			"listing the containers",
		)
		expect(names.split("\n")).toEqual(expect.arrayContaining([STRAY, `open-mcc-${KNOWN}`]))

		const reconciliation = await reconciled()

		expect(reconciliation.unitDrift).toContainEqual({ kind: "unexpected", unit: STRAY })
		expect(reconciliation.unitDrift).not.toContainEqual({
			kind: "unexpected",
			unit: `open-mcc-${KNOWN}`,
		})
		expect(reconciliation.unitDrift).toContainEqual({
			kind: "missing",
			unit: RUNTIME_IMAGE_REPOSITORY,
		})
	})

	it("reports Podman upgraded for a stored slirp4netns stack only where Podman needs pasta", async () => {
		const version = parsePodmanVersion(
			succeeded(await shell(host, as, "podman --version"), "reading the Podman version"),
		)
		expect(version === null ? null : requiredStackFor(version.major)).toBe(target.stack)

		const reconciliation = await reconciled()

		expect(reconciliation.runtimeDrift).toEqual(
			target.stack === "pasta" ? [{ kind: "network-stack" }] : [],
		)
	})

	it("forwards to a published port nothing listens on, so a forward cannot prove a client listens", async () => {
		const key = await mintKey(host)
		await seedAuthorizedKeys(host, ACCOUNT, `${key.publicKey}\n`)
		const forwardTo = async (port: number) =>
			await exec(host, { ...ROOT, timeoutMs: 60_000 }, [
				"ssh",
				"-i",
				key.path,
				...SSH_CLIENT,
				"-W",
				`127.0.0.1:${port}`,
				`${ACCOUNT}@127.0.0.1`,
			])

		const unpublished = await forwardTo(UNPUBLISHED_PORT)
		const published = await forwardTo(STRAY_PORT)
		const answer = await shell(
			host,
			as,
			'curl -s -o /dev/null -m 5 -w "%{http_code}" -X POST "http://127.0.0.1:$1/mcp"',
			String(STRAY_PORT),
		)

		expect(unpublished.status, unpublished.stderr).not.toBe(0)
		expect(published.status, published.stderr).toBe(0)
		expect(answer.stdout).toBe("000")
	})

	it("sends no token while the bot's unit is not active, and sends it only once the unit is", async () => {
		const { controller, clock, opened, sent } = ready()
		const unit = `open-mcc@${LIVE}.service`
		const unitState = async () =>
			(await shell(host, as, 'systemctl --user is-active "$1"', unit)).stdout.trim()
		opened.length = 0
		sent.length = 0

		expect(await unitState()).toBe("inactive")
		await expect(controller.readLiveStatus(owner, LIVE)).resolves.toBeUndefined()
		await expect(
			controller.dropInventoryItem(owner, LIVE, "minecraft:dirt", 1),
		).rejects.toBeInstanceOf(LiveChannelUnavailableError)
		expect({ opened, sent }).toEqual({ opened: [], sent: [] })

		succeeded(await shell(host, as, 'systemctl --user start "$1"', unit), "starting the bot unit")
		expect(await unitState()).toBe("active")
		await expect(controller.readLiveStatus(owner, LIVE)).resolves.toBeUndefined()
		expect(opened).toEqual([LIVE_PORT])
		expect(sent.join("")).toContain(`Bearer ${TOKEN}`)

		succeeded(await shell(host, as, 'systemctl --user stop "$1"', unit), "stopping the bot unit")
		clock.at += 5_000
		opened.length = 0
		sent.length = 0
		await expect(controller.readLiveStatus(owner, LIVE)).resolves.toBeUndefined()
		expect({ opened, sent }).toEqual({ opened: [], sent: [] })
	})
})
