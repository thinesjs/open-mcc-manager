import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { SecretStore } from "../crypto/sealed-box"
import { type ActorContext, ForbiddenError } from "../host/host.controller"
import { seedMember, seedOrganization, teardownTestDb, testDb } from "../test/db"
import {
	createDestinationController,
	createDestinationControllerTransaction,
	DestinationNotFoundError,
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
let operator: ActorContext = { organizationId: "", memberId: "", actorLabel: "", role: "operator" }

const seedFailedDelivery = async (): Promise<string> => {
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
			attempts: 8,
			settledAt: new Date(),
			lastError: "Server refused with 404",
		})
		.execute()
	return deliveryId
}

const dismissalsRecorded = async (deliveryId: string): Promise<number> => {
	const rows = await testDb()
		.selectFrom("auditEvent")
		.select("id")
		.where("organizationId", "=", organizationId)
		.where("action", "=", "notification.delivery.dismiss")
		.where("subjectId", "=", deliveryId)
		.execute()
	return rows.length
}

beforeAll(async () => {
	organizationId = await seedOrganization("dismiss")
	const memberId = await seedMember(organizationId)
	owner = { organizationId, memberId, actorLabel: "owner@example.com", role: "owner" }
	operator = { organizationId, memberId, actorLabel: "operator@example.com", role: "operator" }
})

afterAll(async () => {
	await teardownTestDb()
})

describe("dismissing an alert that did not arrive", () => {
	it("settles the delivery and records who dismissed it", async () => {
		const deliveryId = await seedFailedDelivery()

		await controller.dismiss(owner, deliveryId)

		const row = await createNotificationRepository(testDb()).findDelivery(
			{ organizationId },
			deliveryId,
		)
		expect(row?.state).toBe("abandoned")
		expect(await dismissalsRecorded(deliveryId)).toBe(1)
	})

	it("refuses somebody who may only read alerts, and changes nothing", async () => {
		const deliveryId = await seedFailedDelivery()

		await expect(controller.dismiss(operator, deliveryId)).rejects.toThrow(ForbiddenError)

		const row = await createNotificationRepository(testDb()).findDelivery(
			{ organizationId },
			deliveryId,
		)
		expect(row?.state).toBe("failed")
		expect(await dismissalsRecorded(deliveryId)).toBe(0)
	})

	it("says so when the alert is not there to dismiss", async () => {
		await expect(controller.dismiss(owner, `del-${suffix()}`)).rejects.toThrow(
			DestinationNotFoundError,
		)
	})
})
