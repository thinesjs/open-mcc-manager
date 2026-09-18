import { instanceConfigStored, instanceSettingsInput } from "@open-mcc/contracts"
import {
	createFakeTransport,
	createReadConnections,
	type FakeScript,
	READ_CONNECTION_CHANNEL_LIMIT,
	READ_CONNECTION_HARD_AGE_MS,
	READ_CONNECTION_IDLE_MS,
} from "@open-mcc/transport"
import { sql } from "kysely"
import { afterAll, describe, expect, it } from "vitest"
import { createHostRepository } from "../host/host.repository"
import { HostRefusedError } from "../lib/errors"
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
	InstanceBusyError,
	InstanceConcurrentlyModifiedError,
} from "./instance.controller"
import { CONFIG_CLAIM_LEASE_MS, createInstanceRepository } from "./instance.repository"
import { createScheduleRepository } from "./schedule.repository"
import {
	ENV_WRITTEN,
	envWriteUnlessRunningCommand,
	renderEnvironmentFile,
	startUnitCommand,
} from "./unit"

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
	await db
		.updateTable("host")
		.set({ networkStack: "slirp4netns", architecture: "x64" })
		.where("id", "=", host.id)
		.execute()
	nextPort += 1
	const instances = createInstanceRepository(db)
	const seedClaim = `seed-${slugPrefix}`
	const inserted = await instances.insert(
		scope,
		{
			hostId: host.id,
			name: `${slugPrefix}-bot`,
			minecraftAccount: SAVED.minecraftAccount,
			minecraftUsername: null,
			liveControlPort: nextPort,
		},
		seedClaim,
	)
	trackInstanceId(inserted.id)
	const instance = await instances.finalizeConfigClaim(scope, inserted.id, seedClaim, {})
	if (!instance) throw new Error(`Seeded instance ${inserted.id} kept its claim`)
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
	return {
		actor,
		scope,
		hostId: host.id,
		instanceId: instance.id,
		liveControlPort: instance.liveControlPort,
		instances,
	}
}

const envExecOf = (instanceId: string, liveControlPort: number): string =>
	envWriteUnlessRunningCommand(
		instanceId,
		renderEnvironmentFile({ liveControlToken: "0".repeat(32) }),
		liveControlPort,
	)

const startAnswers = (instanceId: string, liveControlPort: number): FakeScript => ({
	[envExecOf(instanceId, liveControlPort)]: {
		stdout: `${ENV_WRITTEN}\n`,
		stderr: "",
		exitCode: 0,
	},
	[startUnitCommand(instanceId)]: {
		stdout: "ActiveState=active\nResult=success\nSignIn=inactive\n",
		stderr: "",
		exitCode: 0,
	},
})

const backdateConfigClaim = async (id: string, ageMs: number): Promise<void> => {
	await testDb()
		.updateTable("instance")
		.set({
			configClaimedAt: sql<Date>`clock_timestamp() - ${sql.lit(ageMs)} * interval '1 millisecond'`,
		})
		.where("id", "=", id)
		.execute()
}

const controllerOver = (script: FakeScript = {}) => {
	const db = testDb()
	const transport = createFakeTransport(script)
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

		const refusal = controller.updateSettings(actor, instanceId, SETTINGS, 1)
		await expect(refusal).rejects.toThrow(HostRefusedError)
		await expect(refusal).rejects.toThrow("Failed to write instance config")

		const claimed = await instances.claimForConfig(scope, instanceId, "next-claim")
		expect(claimed?.configClaimId).toBe("next-claim")
	})
})

describe("a bot started while something else wants it", () => {
	it("refuses a save made while a start holds the same bot", async () => {
		const { actor, instanceId, liveControlPort } = await seedBot("claim-start-holds")
		const { controller, transport } = controllerOver(startAnswers(instanceId, liveControlPort))
		const inner = transport.exec
		let refused: Error | undefined
		transport.exec = async (command, timeoutMs, stdin) => {
			if (command.includes("MinecraftClient.ini")) {
				refused = await controller.updateSettings(actor, instanceId, SETTINGS, 1).then(
					() => undefined,
					(error: Error) => error,
				)
			}
			return await inner(command, timeoutMs, stdin)
		}

		await controller.start(actor, instanceId)

		expect(refused).toBeInstanceOf(InstanceBusyError)
	})

	it("stores no token once the claim it minted under was taken away", async () => {
		const { actor, scope, instanceId, liveControlPort, instances } =
			await seedBot("claim-start-token")
		const { controller, transport } = controllerOver(startAnswers(instanceId, liveControlPort))
		const envExec = envExecOf(instanceId, liveControlPort)
		const inner = transport.exec
		transport.exec = async (command, timeoutMs, stdin) => {
			if (command === envExec) {
				await testDb()
					.updateTable("instance")
					.set({ configClaimId: "someone-else" })
					.where("id", "=", instanceId)
					.execute()
			}
			return await inner(command, timeoutMs, stdin)
		}

		await expect(controller.start(actor, instanceId)).rejects.toBeInstanceOf(InstanceBusyError)

		const row = await instances.findById(scope, instanceId)
		expect(row?.liveControlTokenEncrypted).toBeNull()
		expect(row?.status).not.toBe("running")
		expect(transport.commands.some((each) => each.includes("systemctl --user start"))).toBe(false)
	})

	it("cannot say a bot is running once a sign-in has taken its stale claim over", async () => {
		const { actor, scope, instanceId, liveControlPort, instances } =
			await seedBot("claim-start-stale")
		const { controller, transport } = controllerOver(startAnswers(instanceId, liveControlPort))
		const inner = transport.exec
		transport.exec = async (command, timeoutMs, stdin) => {
			const result = await inner(command, timeoutMs, stdin)
			if (command.includes("systemctl --user start")) {
				await backdateConfigClaim(instanceId, CONFIG_CLAIM_LEASE_MS + 60_000)
				await instances.claimForAuth(scope, instanceId, "sign-in")
				await instances.update(scope, instanceId, { status: "needs_auth" })
			}
			return result
		}

		await expect(controller.start(actor, instanceId)).rejects.toBeInstanceOf(InstanceBusyError)

		expect((await instances.findById(scope, instanceId))?.status).toBe("needs_auth")
	})
})

describe("a bot still being created", () => {
	const NEW_BOT = "claim-create-new"

	const makeBot = async (
		controller: ReturnType<typeof createInstanceController>,
		actor: ActorContext,
		hostId: string,
	) => {
		const made = await controller.create(actor, {
			hostId,
			name: NEW_BOT,
			accountType: "offline",
			minecraftAccount: "afk",
			serverAddress: "play.example.net",
		})
		trackInstanceId(made.id)
		return made
	}

	it("refuses a save aimed at it until the last of its four layout steps has run", async () => {
		const { actor, scope, hostId, instances } = await seedBot("claim-create")
		const { controller, transport } = controllerOver()
		const inner = transport.exec
		let refused: Error | undefined
		let claimedDuring: { id: string | null; at: Date | null } | undefined
		transport.exec = async (command, timeoutMs, stdin) => {
			const made = (await instances.list(scope)).find((row) => row.name === NEW_BOT)
			if (made && claimedDuring === undefined) {
				claimedDuring = { id: made.configClaimId, at: made.configClaimedAt }
				refused = await controller.updateSettings(actor, made.id, SETTINGS, 1).then(
					() => undefined,
					(error: Error) => error,
				)
			}
			return await inner(command, timeoutMs, stdin)
		}

		const created = await makeBot(controller, actor, hostId)

		expect(claimedDuring?.id).toEqual(expect.any(String))
		expect(claimedDuring?.at).toBeInstanceOf(Date)
		expect(refused).toBeInstanceOf(InstanceBusyError)
		const settled = await instances.findById(scope, created.id)
		expect(settled?.configClaimId).toBeNull()
		expect(settled?.configClaimedAt).toBeNull()
	})

	it("takes the same save once its creation has finished", async () => {
		const { actor, hostId } = await seedBot("claim-created")
		const { controller } = controllerOver()

		const created = await makeBot(controller, actor, hostId)
		const saved = await controller.updateSettings(actor, created.id, SETTINGS, 1)

		expect(saved.version).toBe(2)
	})
})
