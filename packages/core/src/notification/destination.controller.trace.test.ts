import { trace } from "@opentelemetry/api"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { SecretStore } from "../crypto/sealed-box"
import type { ActorContext } from "../host/host.controller"
import { activeTraceIds, startTracing } from "../log/tracing"
import { seedMember, seedOrganization, teardownTestDb, testDb } from "../test/db"
import {
	createDestinationController,
	createDestinationControllerTransaction,
} from "./destination.controller"
import { PUBLIC_ONLY } from "./egress"
import { createNotificationRepository } from "./notification.repository"

const tracing = startTracing({
	service: "destination-controller",
	endpoint: "http://127.0.0.1:4318",
})

const secrets: SecretStore = {
	activeKeyId: "key-1",
	seal: (plaintext) => ({ ciphertext: plaintext, keyId: "key-1" }),
	open: (ciphertext) => ciphertext,
}

const queued: Record<string, string>[] = []

const controller = createDestinationController({
	withTransaction: createDestinationControllerTransaction(testDb()),
	notifications: createNotificationRepository(testDb()),
	secrets,
	sendJob: async (_queue, payload) => {
		queued.push(payload)
		return "job"
	},
	policy: PUBLIC_ONLY,
})

const suffix = (): string => Math.random().toString(36).slice(2, 10)

let organizationId = ""
let owner: ActorContext = { organizationId: "", memberId: "", actorLabel: "", role: "owner" }

const seedDestination = async (): Promise<string> => {
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
	return destinationId
}

const seedFailedDelivery = async (destinationId: string): Promise<string> => {
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

const whileTracing = async (act: () => Promise<void>): Promise<string> =>
	await trace.getTracer("operator-action").startActiveSpan("acting", async (span) => {
		const ids = activeTraceIds()
		await act()
		span.end()
		return ids?.trace_id ?? ""
	})

beforeAll(async () => {
	organizationId = await seedOrganization("dest-trace")
	const memberId = await seedMember(organizationId)
	owner = { organizationId, memberId, actorLabel: "owner@example.com", role: "owner" }
})

afterAll(async () => {
	await tracing.shutdown()
	await teardownTestDb()
})

describe("an operator action hands its trace to the job it queues", () => {
	it("puts the retrying trace on the job a retry enqueues", async () => {
		const deliveryId = await seedFailedDelivery(await seedDestination())
		queued.length = 0

		const traceId = await whileTracing(async () => {
			await controller.retry(owner, deliveryId)
		})
		const payload = queued.at(-1)

		expect(traceId).toMatch(/^[0-9a-f]{32}$/)
		expect(queued).toHaveLength(1)
		expect(
			payload?.traceparent,
			"the retry enqueue dropped the trace context — is the carrier still spread in?",
		).toBeDefined()
		expect(payload?.traceparent).toContain(traceId)
	})

	it("puts the testing trace on the job a test enqueues", async () => {
		const destinationId = await seedDestination()
		queued.length = 0

		const traceId = await whileTracing(async () => {
			await controller.test(owner, destinationId)
		})
		const payload = queued.at(-1)

		expect(traceId).toMatch(/^[0-9a-f]{32}$/)
		expect(queued).toHaveLength(1)
		expect(
			payload?.traceparent,
			"the test enqueue dropped the trace context — is the carrier still spread in?",
		).toBeDefined()
		expect(payload?.traceparent).toContain(traceId)
	})
})
