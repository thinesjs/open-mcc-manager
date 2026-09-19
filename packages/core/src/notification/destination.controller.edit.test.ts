import { ROTATION_OVERLAP_MS } from "@open-mcc/contracts"
import { readDestinationConfig } from "@open-mcc/contracts/boundary/destination-config"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { SecretStore } from "../crypto/sealed-box"
import type { ActorContext } from "../host/host.controller"
import { seedMember, seedOrganization, teardownTestDb, testDb } from "../test/db"
import {
	createDestinationController,
	createDestinationControllerTransaction,
} from "./destination.controller"
import { PUBLIC_ONLY } from "./egress"
import { createNotificationRepository } from "./notification.repository"

const secrets: SecretStore = {
	activeKeyId: "key-1",
	seal: (plaintext) => ({ ciphertext: plaintext, keyId: "key-1" }),
	open: (ciphertext) => ciphertext,
}

const now = new Date("2026-09-07T12:00:00Z")

const controller = createDestinationController({
	withTransaction: createDestinationControllerTransaction(testDb()),
	notifications: createNotificationRepository(testDb()),
	secrets,
	sendJob: async () => "job",
	policy: PUBLIC_ONLY,
	now: () => now,
})

const suffix = (): string => Math.random().toString(36).slice(2, 10)

let organizationId = ""
let owner: ActorContext = { organizationId: "", memberId: "", actorLabel: "", role: "owner" }

const seedWebhook = async (previousExpiresAt: string | undefined): Promise<string> => {
	const id = `dest-${suffix()}`
	const config = {
		url: "https://hooks.example.com/first",
		signingSecret: "whsec_CURRENT",
		...(previousExpiresAt === undefined
			? {}
			: {
					previousSigningSecret: "whsec_PREVIOUS",
					previousSigningSecretExpiresAt: previousExpiresAt,
				}),
	}
	await testDb()
		.insertInto("notificationDestination")
		.values({
			id,
			organizationId,
			name: id,
			kind: "webhook",
			displayTarget: "https://hooks.example.com",
			secretEncrypted: JSON.stringify(config),
			secretKeyId: "key-1",
		})
		.execute()
	await testDb()
		.insertInto("notificationSubscription")
		.values({ id: `sub-${suffix()}`, organizationId, destinationId: id, kind: "host.unreachable" })
		.execute()
	return id
}

const storedConfig = async (destinationId: string) => {
	const row = await testDb()
		.selectFrom("notificationDestination")
		.select(["kind", "secretEncrypted"])
		.where("organizationId", "=", organizationId)
		.where("id", "=", destinationId)
		.executeTakeFirstOrThrow()
	return readDestinationConfig(row.kind, row.secretEncrypted)
}

beforeAll(async () => {
	organizationId = await seedOrganization("edit-secret")
	const memberId = await seedMember(organizationId)
	owner = { organizationId, memberId, actorLabel: "owner", role: "owner" }
})

afterAll(async () => {
	await teardownTestDb()
})

const editTo = async (destinationId: string, url: string) =>
	await controller.edit(owner, {
		destinationId,
		name: `renamed-${suffix()}`,
		destination: { kind: "webhook", config: { url } },
		subscribedTo: ["host.unreachable"],
	})

describe("editing a webhook part-way through a key rotation", () => {
	it("keeps a previous key that has not expired, so a receiver still on it keeps working", async () => {
		const unexpired = new Date(now.getTime() + ROTATION_OVERLAP_MS).toISOString()
		const destinationId = await seedWebhook(unexpired)

		await editTo(destinationId, "https://hooks.example.com/second")
		const config = await storedConfig(destinationId)

		expect(config?.kind).toBe("webhook")
		expect(config?.kind === "webhook" && config.config.previousSigningSecret).toBe("whsec_PREVIOUS")
		expect(config?.kind === "webhook" && config.config.previousSigningSecretExpiresAt).toBe(
			unexpired,
		)
	})

	it("drops a previous key whose overlap has run out", async () => {
		const expired = new Date(now.getTime() - 1000).toISOString()
		const destinationId = await seedWebhook(expired)

		await editTo(destinationId, "https://hooks.example.com/second")
		const config = await storedConfig(destinationId)

		expect(config?.kind === "webhook" && config.config.previousSigningSecret).toBeUndefined()
	})

	it("keeps the current key across an edit, so an edit is not a silent rotation", async () => {
		const destinationId = await seedWebhook(undefined)

		await editTo(destinationId, "https://hooks.example.com/second")
		const config = await storedConfig(destinationId)

		expect(config?.kind === "webhook" && config.config.signingSecret).toBe("whsec_CURRENT")
	})

	it("saves the new address", async () => {
		const destinationId = await seedWebhook(undefined)

		await editTo(destinationId, "https://hooks.example.com/second")
		const config = await storedConfig(destinationId)

		expect(config?.kind === "webhook" && config.config.url).toBe("https://hooks.example.com/second")
	})
})
