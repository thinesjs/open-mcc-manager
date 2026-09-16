import { instanceConfigStored, instanceSettingsInput } from "@open-mcc/contracts"
import {
	createFakeTransport,
	createReadConnections,
	READ_CONNECTION_CHANNEL_LIMIT,
	READ_CONNECTION_HARD_AGE_MS,
	READ_CONNECTION_IDLE_MS,
} from "@open-mcc/transport"
import { afterAll, describe, expect, it } from "vitest"
import { createHostRepository } from "../host/host.repository"
import { createSshKeyRepository } from "../ssh-key/ssh-key.repository"
import {
	seedMember,
	seedOrganization,
	teardownTestDb,
	testDb,
	trackHostId,
	trackInstanceConfigId,
	trackInstanceId,
	trackSshKeyId,
} from "../test/db"
import { createCommandRepository } from "./command.repository"
import {
	type ActorContext,
	createInstanceController,
	createInstanceControllerTransaction,
	InstanceConcurrentlyModifiedError,
} from "./instance.controller"
import { createInstanceRepository } from "./instance.repository"
import { createScheduleRepository } from "./schedule.repository"

const SAVED = {
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
	liveControlPort: 33333,
	worldDataEnabled: false,
	inventoryDataEnabled: false,
	entityDataEnabled: false,
	advancedKeys: {},
	botConfig: {},
}

const SETTINGS = instanceSettingsInput.parse({
	accountType: SAVED.accountType,
	minecraftAccount: SAVED.minecraftAccount,
	serverAddress: SAVED.serverAddress,
	autoRelogRetries: SAVED.autoRelogRetries,
	autoRelogEnabled: SAVED.autoRelogEnabled,
	autoRelogDelaySeconds: SAVED.autoRelogDelaySeconds,
	antiAfkEnabled: SAVED.antiAfkEnabled,
	antiAfkIntervalSeconds: SAVED.antiAfkIntervalSeconds,
	autoRespawnEnabled: SAVED.autoRespawnEnabled,
	liveControlEnabled: SAVED.liveControlEnabled,
	liveControlPort: SAVED.liveControlPort,
	worldDataEnabled: SAVED.worldDataEnabled,
	inventoryDataEnabled: SAVED.inventoryDataEnabled,
	entityDataEnabled: SAVED.entityDataEnabled,
})

let nextPort = 41000

const seedBot = async (slugPrefix: string) => {
	const organizationId = await seedOrganization(slugPrefix)
	const memberId = await seedMember(organizationId)
	const db = testDb()
	const scope = { organizationId }
	const sshKey = await createSshKeyRepository(db).insert(scope, {
		name: `${slugPrefix}-key`,
		publicKey: "ssh-ed25519 AAAA",
		privateKeyEncrypted: "sealed",
		privateKeyKeyId: "k1",
	})
	trackSshKeyId(sshKey.id)
	const host = await createHostRepository(db).insert(scope, {
		name: `${slugPrefix}-host`,
		hostname: "127.0.0.1",
		port: 22,
		username: "mcc",
		osRelease: "systemd 252",
		osId: "debian",
		osName: "Debian GNU/Linux 12 (bookworm)",
		failedUnits: null,
		teardownError: null,
		teardownRequestedAt: null,
		sshKeyId: sshKey.id,
		hostKeyAlgorithm: "ssh-ed25519",
		hostKeyFingerprint: "SHA256:trusted",
		hostKeyTrustedBy: memberId,
		hostKeyTrustedByLabel: "actor@example.com",
		hostKeyTrustedAt: new Date(),
		status: "ready",
	})
	trackHostId(host.id)
	nextPort += 1
	const instances = createInstanceRepository(db)
	const instance = await instances.insert(scope, {
		hostId: host.id,
		name: `${slugPrefix}-bot`,
		minecraftAccount: SAVED.minecraftAccount,
		minecraftUsername: null,
		liveControlPort: nextPort,
	})
	trackInstanceId(instance.id)
	const version = await instances.insertConfigVersion(
		scope,
		instance.id,
		JSON.stringify({ ...SAVED, liveControlPort: instance.liveControlPort }),
		{ authorId: memberId, authorLabel: "actor@example.com" },
	)
	trackInstanceConfigId(version.id)
	const actor: ActorContext = {
		organizationId,
		memberId,
		actorLabel: "actor@example.com",
		role: "owner",
	}
	return { actor, scope, instanceId: instance.id, instances }
}

const controllerOver = () => {
	const db = testDb()
	const transport = createFakeTransport({})
	return {
		transport,
		controller: createInstanceController({
			instances: createInstanceRepository(db),
			schedules: createScheduleRepository(db),
			commands: createCommandRepository(db),
			hosts: createHostRepository(db),
			sshKeys: createSshKeyRepository(db),
			secrets: {
				open: () => "PRIVATE KEY",
				seal: (plaintext: string) => ({ ciphertext: `sealed(${plaintext.length})`, keyId: "k1" }),
				activeKeyId: "k1",
			},
			createTransport: () => transport,
			readConnections: createReadConnections({
				createTransport: () => transport,
				idleMs: READ_CONNECTION_IDLE_MS,
				hardAgeMs: READ_CONNECTION_HARD_AGE_MS,
				channelLimit: READ_CONNECTION_CHANNEL_LIMIT,
				now: () => Date.now(),
			}),
			withTransaction: createInstanceControllerTransaction(db),
			now: () => Date.now(),
		}),
	}
}

describe("two operators saving the same bot", () => {
	afterAll(async () => {
		await teardownTestDb()
	})

	it("refuses the second save outright rather than letting it overwrite the first", async () => {
		const { actor, scope, instanceId, instances } = await seedBot("claim-lost-update")
		const { controller, transport } = controllerOver()

		const first = await controller.updateSettings(
			actor,
			instanceId,
			{ ...SETTINGS, serverAddress: "first.example.net" },
			1,
		)
		const writesAfterFirst = transport.stdins.length

		await expect(
			controller.updateBotConfig(
				actor,
				instanceId,
				{ botConfig: { "ChatBot.Alerts.Enabled": "true" }, advancedKeys: {} },
				1,
			),
		).rejects.toBeInstanceOf(InstanceConcurrentlyModifiedError)

		expect(first.version).toBe(2)
		expect(transport.stdins).toHaveLength(writesAfterFirst)
		const latest = await instances.latestConfig(scope, instanceId)
		expect(latest?.version).toBe(2)
		expect(instanceConfigStored.parse(latest?.document).serverAddress).toBe("first.example.net")
	})

	it("frees the bot for the next save as soon as a write fails outright", async () => {
		const { actor, scope, instanceId, instances } = await seedBot("claim-release")
		const { controller, transport } = controllerOver()
		const inner = transport.exec
		transport.exec = async (command, timeoutMs, stdin) =>
			command.includes("MinecraftClient.ini")
				? { stdout: "", stderr: "refused", exitCode: 1 }
				: await inner(command, timeoutMs, stdin)

		await expect(controller.updateSettings(actor, instanceId, SETTINGS, 1)).rejects.toThrow(
			"Failed to write instance config",
		)

		const claimed = await instances.claimForConfig(scope, instanceId, "next-claim")
		expect(claimed?.configClaimId).toBe("next-claim")
	})
})
