import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { SecretStore } from "../crypto/sealed-box"
import { type ActorContext, ForbiddenError } from "../host/host.controller"
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

const controller = createDestinationController({
	withTransaction: createDestinationControllerTransaction(testDb()),
	notifications: createNotificationRepository(testDb()),
	secrets,
	sendJob: async () => "job",
	policy: PUBLIC_ONLY,
})

const suffix = (): string => Math.random().toString(36).slice(2, 10)

let organizationId = ""
let owner: ActorContext = { organizationId: "", memberId: "", actorLabel: "", role: "owner" }
let viewer: ActorContext = { organizationId: "", memberId: "", actorLabel: "", role: "viewer" }

const seedFailedDelivery = async (settledAt: Date): Promise<string> => {
	const destinationId = `dest-${suffix()}`
	await testDb()
		.insertInto("notificationDestination")
		.values({
			id: destinationId,
			organizationId,
			name: destinationId,
			kind: "webhook",
			displayTarget: "https://hooks.example.invalid",
			secretEncrypted: "sealed",
			secretKeyId: "key-1",
		})
		.execute()

	const notificationId = `notif-${suffix()}`
	await testDb()
		.insertInto("notification")
		.values({
			id: notificationId,
			organizationId,
			kind: "host.unreachable",
			title: "basement-box is unreachable",
			body: "The last three checks did not answer.",
			subjectType: "host",
			subjectId: `host-${suffix()}`,
			dedupeKey: `event:${suffix()}`,
		})
		.execute()

	const deliveryId = `del-${suffix()}`
	await testDb()
		.insertInto("notificationDelivery")
		.values({
			id: deliveryId,
			organizationId,
			notificationId,
			destinationId,
			state: "failed",
			attempts: 1,
			settledAt,
			lastError: "Server refused with 404",
		})
		.execute()
	return deliveryId
}

beforeAll(async () => {
	organizationId = await seedOrganization("failures-page")
	const memberId = await seedMember(organizationId)
	owner = { organizationId, memberId, actorLabel: "owner@example.com", role: "owner" }
	viewer = { organizationId, memberId, actorLabel: "viewer@example.com", role: "viewer" }
})

afterAll(async () => {
	await teardownTestDb()
})

describe("reading alerts that did not arrive", () => {
	it("defaults to the first page and reports the full count", async () => {
		for (let i = 0; i < 22; i += 1) {
			await seedFailedDelivery(new Date(Date.now() - i * 1000))
		}

		const page = await controller.failures(owner, { offset: 0 })

		expect(page.items).toHaveLength(20)
		expect(page.total).toBe(22)
		expect(page.offset).toBe(0)
	})

	it("refuses somebody who may only see instances, not alerts", async () => {
		await expect(controller.failures(viewer, { offset: 0 })).rejects.toThrow(ForbiddenError)
	})
})
