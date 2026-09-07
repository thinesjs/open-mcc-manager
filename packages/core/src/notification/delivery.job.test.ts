import { asSqlRunner } from "@open-mcc/contracts/boundary/sql-runner"
import type { NotificationDestinationRow } from "@open-mcc/db"
import { describe, expect, it, vi } from "vitest"
import { NOTIFICATION_DEADLETTER_QUEUE, NOTIFICATION_HTTP_QUEUE } from "../job/queue-setup"
import {
	backoffSeconds,
	createDeliveryHandler,
	type DeliveryStore,
	nextDelaySeconds,
	readDeliveryPayload,
} from "./delivery.job"
import { PUBLIC_ONLY } from "./egress"
import type { DeliveryOutcome } from "./outcome"

const payload = { organizationId: "org_1", deliveryId: "del_1", attempt: 1 }

const runner = asSqlRunner(async () => ({ rows: [] }))

const destination = {
	id: "dst_1",
	organizationId: "org_1",
	name: "My webhook",
	kind: "webhook",
	enabled: true,
	displayTarget: "https://hooks.example.com",
	secretEncrypted: "sealed",
	secretKeyId: "key",
	createdAt: new Date(),
	lastSucceededAt: null,
	lastFailedAt: null,
	lastFailureReason: null,
} satisfies NotificationDestinationRow

const notification = {
	id: "ntf_1",
	organizationId: "org_1",
	kind: "host.unreachable" as const,
	title: "basement-box is not responding",
	body: "OpenMCC cannot reach this machine.",
	subjectType: "host" as const,
	subjectId: "host_1",
	dedupeKey: "event:evt_1",
	sourceStatusEventId: "evt_1",
	createdAt: new Date(),
}

const queuedDelivery = {
	id: "del_1",
	organizationId: "org_1",
	notificationId: "ntf_1",
	destinationId: "dst_1",
	state: "queued" as const,
	attempts: 0,
	createdAt: new Date(),
	settledAt: null,
	lastError: null,
}

const build = (
	outcome: DeliveryOutcome | (() => Promise<DeliveryOutcome>),
	over: Partial<DeliveryStore> = {},
	extra: { retryLimit?: number } = {},
) => {
	const settle = vi.fn(async () => undefined)
	const attempt = vi.fn(async () => undefined)
	const disable = vi.fn(async () => undefined)
	const marked = vi.fn(async () => undefined)
	const findDestination = vi.fn(async () => destination)
	const findNotification = vi.fn(async () => notification)

	const store: DeliveryStore = {
		findDelivery: over.findDelivery ?? (async () => queuedDelivery),
		findDestination: over.findDestination ?? findDestination,
		findNotification: over.findNotification ?? findNotification,
		settleDelivery: over.settleDelivery ?? settle,
		recordAttempt: over.recordAttempt ?? attempt,
		disableDestination: over.disableDestination ?? disable,
		markDestinationOutcome: over.markDestinationOutcome ?? marked,
	}

	const send = vi.fn(typeof outcome === "function" ? outcome : async () => outcome)
	const sendJob = vi.fn(async () => "job_1")

	const handle = createDeliveryHandler({
		store,
		withTransaction: async (fn) => await fn({ notifications: store, runner }),
		send,
		sendJob,
		queue: NOTIFICATION_HTTP_QUEUE,
		policy: PUBLIC_ONLY,
		now: () => new Date("2026-09-07T12:00:00Z"),
		...(extra.retryLimit === undefined ? {} : { retryLimit: extra.retryLimit }),
	})

	return { handle, send, sendJob, settle, attempt, disable, marked, findDestination }
}

describe("reading the job", () => {
	it("accepts a payload and defaults the first attempt", () => {
		expect(readDeliveryPayload({ organizationId: "org_1", deliveryId: "del_1" })).toEqual({
			organizationId: "org_1",
			deliveryId: "del_1",
			attempt: 1,
		})
	})

	it("reads an attempt that pg-boss handed back as text", () => {
		expect(readDeliveryPayload({ ...payload, attempt: "3" })?.attempt).toBe(3)
	})

	it("refuses a payload it cannot trust", () => {
		for (const bad of [
			{},
			{ organizationId: "org_1" },
			{ ...payload, deliveryId: "" },
			{ ...payload, attempt: 0 },
			{ ...payload, attempt: "later" },
			{ ...payload, attempt: 1.5 },
		]) {
			expect(readDeliveryPayload(bad)).toBeUndefined()
		}
	})

	it("carries no relational ids, so a job cannot point at another notification", () => {
		const read = readDeliveryPayload({
			...payload,
			notificationId: "ntf_9",
			destinationId: "dst_9",
		})
		expect(read).toEqual(payload)
	})
})

describe("which rows a job is allowed to touch", () => {
	it("takes the notification and destination from the delivery, never from the job", async () => {
		const { handle, findDestination } = build({ kind: "delivered", statusCode: 200 })
		await handle(payload)

		expect(findDestination).toHaveBeenCalledWith({ organizationId: "org_1" }, "dst_1")
	})
})

describe("a delivery that has already been settled", () => {
	it.each(["delivered", "failed", "abandoned"] as const)(
		"is not sent again when it is already %s",
		async (state) => {
			const { handle, send } = build(
				{ kind: "delivered", statusCode: 200 },
				{ findDelivery: async () => ({ ...queuedDelivery, state, attempts: 1 }) },
			)

			expect(await handle(payload)).toEqual({ settled: "skipped" })
			expect(send).not.toHaveBeenCalled()
		},
	)

	it("gives up when the destination has been removed", async () => {
		const { handle, send, settle } = build(
			{ kind: "delivered", statusCode: 200 },
			{
				findDestination: async () => undefined,
			},
		)

		expect(await handle(payload)).toEqual({ settled: "abandoned" })
		expect(send).not.toHaveBeenCalled()
		expect(settle).toHaveBeenCalledWith(
			{ organizationId: "org_1" },
			"del_1",
			expect.objectContaining({ state: "abandoned" }),
		)
	})
})

describe("a delivery that lands", () => {
	it("settles as delivered, marks the destination healthy and queues nothing", async () => {
		const { handle, settle, marked, sendJob } = build({ kind: "delivered", statusCode: 200 })

		expect(await handle(payload)).toEqual({ settled: "delivered" })
		expect(settle).toHaveBeenCalledWith(
			{ organizationId: "org_1" },
			"del_1",
			expect.objectContaining({ state: "delivered", lastError: null }),
		)
		expect(marked).toHaveBeenCalledWith(
			{ organizationId: "org_1" },
			"dst_1",
			expect.objectContaining({ failedAt: null, reason: null }),
		)
		expect(sendJob).not.toHaveBeenCalled()
	})
})

describe("a delivery that fails for good", () => {
	it("settles as failed and sets it aside itself, rather than letting the job simply complete", async () => {
		const { handle, settle, sendJob } = build({
			kind: "terminal",
			statusCode: 404,
			reason: "Server refused with 404",
			stopSending: false,
		})

		expect(await handle(payload)).toEqual({ settled: "failed" })
		expect(settle).toHaveBeenCalledWith(
			{ organizationId: "org_1" },
			"del_1",
			expect.objectContaining({ state: "failed" }),
		)
		expect(sendJob).toHaveBeenCalledWith(
			NOTIFICATION_DEADLETTER_QUEUE,
			expect.objectContaining({ deliveryId: "del_1" }),
			expect.anything(),
		)
	})

	it("turns the destination off only when it asked us to stop", async () => {
		const { handle, disable } = build({
			kind: "terminal",
			statusCode: 410,
			reason: "This destination asked us to stop sending",
			stopSending: true,
		})

		await handle(payload)
		expect(disable).toHaveBeenCalledWith({ organizationId: "org_1" }, "dst_1")
	})

	it("keeps a thrown error out of the stored reason", async () => {
		const { handle, attempt } = build(async () => {
			throw new Error("failed using whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw to sign")
		})

		await handle(payload)
		expect(JSON.stringify(attempt.mock.calls)).not.toContain("whsec_MfKQ")
		expect(attempt).toHaveBeenCalled()
	})
})

describe("a delivery worth trying again", () => {
	const retryable: DeliveryOutcome = {
		kind: "retryable",
		statusCode: 503,
		reason: "Server answered 503",
		retryAfterSeconds: 45,
	}

	it("queues itself again with the next attempt and the wait it owes", async () => {
		const { handle, sendJob } = build(retryable)

		expect(await handle(payload)).toEqual({ settled: "retrying", afterSeconds: 45 })
		expect(sendJob).toHaveBeenCalledWith(
			NOTIFICATION_HTTP_QUEUE,
			expect.objectContaining({ deliveryId: "del_1", attempt: "2" }),
			expect.anything(),
			{ startAfterSeconds: 45 },
		)
	})

	it("leaves the delivery queued rather than settling it", async () => {
		const { handle, settle } = build(retryable)
		await handle(payload)

		expect(settle).toHaveBeenCalledWith(
			{ organizationId: "org_1" },
			"del_1",
			expect.objectContaining({ state: "queued", settledAt: null }),
		)
	})

	it("stops trying once the budget is spent, and sets it aside", async () => {
		const { handle, sendJob } = build(retryable, {}, { retryLimit: 3 })

		expect(await handle({ ...payload, attempt: 3 })).toEqual({ settled: "failed" })
		expect(sendJob).toHaveBeenCalledWith(
			NOTIFICATION_DEADLETTER_QUEUE,
			expect.anything(),
			expect.anything(),
		)
	})
})

describe("how long we wait before trying again", () => {
	it("backs off further with each attempt", () => {
		expect(backoffSeconds(1)).toBe(15)
		expect(backoffSeconds(2)).toBe(30)
		expect(backoffSeconds(3)).toBe(60)
	})

	it("never waits longer than an hour", () => {
		expect(backoffSeconds(99)).toBe(60 * 60)
		expect(nextDelaySeconds(1, 999_999)).toBe(60 * 60)
	})

	it("never retries sooner than a provider asked, even early on", () => {
		expect(nextDelaySeconds(1, 300)).toBe(300)
		expect(nextDelaySeconds(1, 5)).toBe(15)
		expect(nextDelaySeconds(1, undefined)).toBe(15)
	})
})

describe("a destination the operator turned off", () => {
	it("is not sent to, even when a delivery was already queued for it", async () => {
		const { handle, send, settle } = build(
			{ kind: "delivered", statusCode: 200 },
			{
				findDestination: async () => ({ ...destination, enabled: false }),
			},
		)

		expect(await handle(payload)).toEqual({ settled: "abandoned" })
		expect(send).not.toHaveBeenCalled()
		expect(settle).toHaveBeenCalledWith(
			{ organizationId: "org_1" },
			"del_1",
			expect.objectContaining({ state: "abandoned" }),
		)
	})

	it("says why, in words an operator will recognise", async () => {
		const { handle, settle } = build(
			{ kind: "delivered", statusCode: 200 },
			{
				findDestination: async () => ({ ...destination, enabled: false }),
			},
		)
		await handle(payload)

		expect(JSON.stringify(settle.mock.calls)).toContain("turned off")
	})
})
