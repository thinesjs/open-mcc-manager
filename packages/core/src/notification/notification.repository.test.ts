import type { DeliveryState, DestinationKind, SubscriptionKind } from "@open-mcc/db"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { seedOrganization, teardownTestDb, testDb } from "../test/db"
import { createNotificationRepository } from "./notification.repository"

const repo = createNotificationRepository(testDb())

let orgA = ""
let orgB = ""

const suffix = (): string => Math.random().toString(36).slice(2, 10)

const seedDestination = async (
	organizationId: string,
	options: {
		kind?: DestinationKind
		enabled?: boolean
		subscribedTo?: readonly SubscriptionKind[]
	} = {},
): Promise<string> => {
	const id = `dest-${suffix()}`
	await testDb()
		.insertInto("notificationDestination")
		.values({
			id,
			organizationId,
			name: id,
			kind: options.kind ?? "webhook",
			enabled: options.enabled ?? true,
			displayTarget: "https://hooks.example.invalid/inbox",
			secretEncrypted: "sealed",
			secretKeyId: "key-1",
		})
		.execute()

	for (const kind of options.subscribedTo ?? []) {
		await testDb()
			.insertInto("notificationSubscription")
			.values({ id: `sub-${suffix()}`, organizationId, destinationId: id, kind })
			.execute()
	}

	return id
}

const notification = (dedupeKey: string) => ({
	kind: "host.unreachable" as const,
	title: "basement-box is unreachable",
	body: "The last three checks did not answer.",
	subjectType: "host" as const,
	subjectId: `host-${suffix()}`,
	dedupeKey,
})

beforeAll(async () => {
	orgA = await seedOrganization("notif-a")
	orgB = await seedOrganization("notif-b")
})

afterAll(async () => {
	await teardownTestDb()
})

describe("notification repository organization scoping", () => {
	it("refuses to hand one organization another's destination", async () => {
		const destination = await seedDestination(orgA)

		expect(await repo.findDestination({ organizationId: orgB }, destination)).toBeUndefined()
		expect(await repo.findDestination({ organizationId: orgA }, destination)).toMatchObject({
			id: destination,
		})
	})

	it("leaves another organization's subscribed destinations out of the list", async () => {
		const theirs = await seedDestination(orgA, { subscribedTo: ["instance.flapping"] })
		const ours = await seedDestination(orgB, { subscribedTo: ["instance.flapping"] })

		const found = await repo.destinationsSubscribedTo({ organizationId: orgB }, "instance.flapping")

		expect(found.map((row) => row.id)).toContain(ours)
		expect(found.map((row) => row.id)).not.toContain(theirs)
	})

	it("refuses to hand one organization another's notification", async () => {
		const dedupeKey = `event:${suffix()}`
		await repo.createNotification({ organizationId: orgA }, notification(dedupeKey))

		expect(await repo.notifiedAlready({ organizationId: orgB }, dedupeKey)).toBeUndefined()
		expect(await repo.notifiedAlready({ organizationId: orgA }, dedupeKey)).toMatchObject({
			dedupeKey,
		})
	})

	it("refuses to record a delivery against another organization's notification", async () => {
		const dedupeKey = `event:${suffix()}`
		const theirs = await repo.createNotification({ organizationId: orgA }, notification(dedupeKey))
		if (theirs === undefined) throw new Error("expected the notification to be created")
		const ours = await seedDestination(orgB)

		await expect(
			repo.createDelivery(
				{ organizationId: orgB },
				{ notificationId: theirs.id, destinationId: ours },
			),
		).rejects.toThrow()
	})
})

describe("which destinations hear about a kind", () => {
	it("returns only the destinations subscribed to that kind", async () => {
		const subscribed = await seedDestination(orgA, { subscribedTo: ["instance.needs_auth"] })
		const elsewhere = await seedDestination(orgA, { subscribedTo: ["host.unreachable"] })

		const found = await repo.destinationsSubscribedTo(
			{ organizationId: orgA },
			"instance.needs_auth",
		)

		expect(found.map((row) => row.id)).toContain(subscribed)
		expect(found.map((row) => row.id)).not.toContain(elsewhere)
	})

	it("stays quiet through a destination an operator switched off", async () => {
		const on = await seedDestination(orgA, {
			enabled: true,
			subscribedTo: ["instance.unexpected_stop"],
		})
		const off = await seedDestination(orgA, {
			enabled: false,
			subscribedTo: ["instance.unexpected_stop"],
		})

		const found = await repo.destinationsSubscribedTo(
			{ organizationId: orgA },
			"instance.unexpected_stop",
		)

		expect(found.map((row) => row.id)).toContain(on)
		expect(found.map((row) => row.id)).not.toContain(off)
	})
})

describe("not saying the same thing twice", () => {
	it("ignores a second notification carrying a dedupe key already used", async () => {
		const dedupeKey = `event:${suffix()}`
		const first = await repo.createNotification({ organizationId: orgA }, notification(dedupeKey))
		const second = await repo.createNotification({ organizationId: orgA }, notification(dedupeKey))

		expect(first).toBeDefined()
		expect(second).toBeUndefined()
		expect(await repo.notifiedAlready({ organizationId: orgA }, dedupeKey)).toMatchObject({
			id: first?.id,
		})
	})

	it("still lets another organization use the same dedupe key, because the key is scoped to one", async () => {
		const dedupeKey = `event:${suffix()}`
		const theirs = await repo.createNotification({ organizationId: orgA }, notification(dedupeKey))
		const ours = await repo.createNotification({ organizationId: orgB }, notification(dedupeKey))

		expect(theirs).toBeDefined()
		expect(ours).toBeDefined()
		expect(ours?.id).not.toBe(theirs?.id)
	})

	it("ignores a second delivery for the same notification and destination", async () => {
		const created = await repo.createNotification(
			{ organizationId: orgA },
			notification(`event:${suffix()}`),
		)
		if (created === undefined) throw new Error("expected the notification to be created")
		const destination = await seedDestination(orgA)

		const first = await repo.createDelivery(
			{ organizationId: orgA },
			{ notificationId: created.id, destinationId: destination },
		)
		const second = await repo.createDelivery(
			{ organizationId: orgA },
			{ notificationId: created.id, destinationId: destination },
		)

		expect(first).toBeDefined()
		expect(second).toBeUndefined()
	})
})

const DAY_MS = 24 * 60 * 60 * 1000

const daysAgo = (days: number): Date => new Date(Date.now() - days * DAY_MS)

const seedNotification = async (organizationId: string, createdAt: Date): Promise<string> => {
	const id = `notif-${suffix()}`
	await testDb()
		.insertInto("notification")
		.values({ ...notification(`event:${suffix()}`), id, organizationId, createdAt })
		.execute()
	return id
}

const seedDelivery = async (
	organizationId: string,
	values: {
		notificationId: string
		destinationId: string
		state: DeliveryState
		settledAt: Date | null
		attempts?: number
		lastError?: string | null
	},
): Promise<string> => {
	const id = `del-${suffix()}`
	await testDb()
		.insertInto("notificationDelivery")
		.values({
			id,
			organizationId,
			notificationId: values.notificationId,
			destinationId: values.destinationId,
			state: values.state,
			settledAt: values.settledAt,
			attempts: values.attempts ?? 1,
			lastError: values.lastError ?? null,
		})
		.execute()
	return id
}

const notificationStillThere = async (
	organizationId: string,
	notificationId: string,
): Promise<boolean> =>
	(await repo.findNotification({ organizationId }, notificationId)) !== undefined

const RETENTION = {
	createdBefore: daysAgo(90),
	settledBefore: daysAgo(30),
}

describe("what retention is allowed to remove", () => {
	it("keeps a notification whose delivery only just failed, because a dead letter still names it", async () => {
		const destination = await seedDestination(orgA)
		const older = await seedNotification(orgA, daysAgo(120))
		await seedDelivery(orgA, {
			notificationId: older,
			destinationId: destination,
			state: "failed",
			settledAt: daysAgo(1),
		})

		expect(await repo.deleteSettledBefore({ organizationId: orgA }, RETENTION)).toBe(0)
		expect(await notificationStillThere(orgA, older)).toBe(true)
	})

	it("keeps a notification whose delivery is still waiting to be sent", async () => {
		const destination = await seedDestination(orgA)
		const older = await seedNotification(orgA, daysAgo(120))
		await seedDelivery(orgA, {
			notificationId: older,
			destinationId: destination,
			state: "queued",
			settledAt: null,
		})

		expect(await repo.deleteSettledBefore({ organizationId: orgA }, RETENTION)).toBe(0)
		expect(await notificationStillThere(orgA, older)).toBe(true)
	})

	it("removes a notification past retention whose deliveries settled before any dead letter expired", async () => {
		const destination = await seedDestination(orgA)
		const older = await seedNotification(orgA, daysAgo(120))
		await seedDelivery(orgA, {
			notificationId: older,
			destinationId: destination,
			state: "failed",
			settledAt: daysAgo(100),
		})

		expect(await repo.deleteSettledBefore({ organizationId: orgA }, RETENTION)).toBe(1)
		expect(await notificationStillThere(orgA, older)).toBe(false)
	})

	it("keeps a settled notification that is still inside the retention window", async () => {
		const destination = await seedDestination(orgA)
		const recent = await seedNotification(orgA, daysAgo(2))
		await seedDelivery(orgA, {
			notificationId: recent,
			destinationId: destination,
			state: "delivered",
			settledAt: daysAgo(2),
		})

		expect(await repo.deleteSettledBefore({ organizationId: orgA }, RETENTION)).toBe(0)
		expect(await notificationStillThere(orgA, recent)).toBe(true)
	})

	it("refuses to delete another organization's notifications", async () => {
		const destination = await seedDestination(orgA)
		const theirs = await seedNotification(orgA, daysAgo(120))
		await seedDelivery(orgA, {
			notificationId: theirs,
			destinationId: destination,
			state: "delivered",
			settledAt: daysAgo(100),
		})

		expect(await repo.deleteSettledBefore({ organizationId: orgB }, RETENTION)).toBe(0)
		expect(await notificationStillThere(orgA, theirs)).toBe(true)
	})
})

describe("alerts that did not arrive", () => {
	it("lists a delivery that gave up after trying", async () => {
		const destination = await seedDestination(orgA)
		const created = await seedNotification(orgA, daysAgo(1))
		const settledAt = daysAgo(1)
		const delivery = await seedDelivery(orgA, {
			notificationId: created,
			destinationId: destination,
			state: "failed",
			settledAt,
			attempts: 8,
		})

		const found = await repo.recentFailures({ organizationId: orgA }, 20, 0)

		expect(found.map((row) => row.deliveryId)).toContain(delivery)
		const failure = found.find((row) => row.deliveryId === delivery)
		expect(failure?.settledAt).toBe(settledAt.toISOString())
	})

	it("leaves out a delivery abandoned because its destination was turned off", async () => {
		const destination = await seedDestination(orgA)
		const created = await seedNotification(orgA, daysAgo(1))
		const delivery = await seedDelivery(orgA, {
			notificationId: created,
			destinationId: destination,
			state: "abandoned",
			settledAt: daysAgo(1),
			lastError: "this destination was turned off before it could be sent",
		})

		const found = await repo.recentFailures({ organizationId: orgA }, 20, 0)

		expect(found.map((row) => row.deliveryId)).not.toContain(delivery)
	})

	it("refuses to hand one organization another's failures", async () => {
		const destination = await seedDestination(orgA)
		const created = await seedNotification(orgA, daysAgo(1))
		const delivery = await seedDelivery(orgA, {
			notificationId: created,
			destinationId: destination,
			state: "failed",
			settledAt: daysAgo(1),
		})

		const found = await repo.recentFailures({ organizationId: orgB }, 20, 0)

		expect(found.map((row) => row.deliveryId)).not.toContain(delivery)
	})
})

describe("paginating alerts that did not arrive", () => {
	it("pages through failures with no gap or overlap and counts only its own organization", async () => {
		const org = await seedOrganization("alerts-page")
		const destination = await seedDestination(org)
		const sharedSettledAt = daysAgo(1)
		for (let i = 0; i < 25; i += 1) {
			const created = await seedNotification(org, daysAgo(1))
			await seedDelivery(org, {
				notificationId: created,
				destinationId: destination,
				state: "failed",
				settledAt: sharedSettledAt,
			})
		}

		const delivered = await seedNotification(org, daysAgo(1))
		const abandoned = await seedNotification(org, daysAgo(1))
		const queued = await seedNotification(org, daysAgo(1))
		const notFailed = [
			await seedDelivery(org, {
				notificationId: delivered,
				destinationId: destination,
				state: "delivered",
				settledAt: daysAgo(1),
			}),
			await seedDelivery(org, {
				notificationId: abandoned,
				destinationId: destination,
				state: "abandoned",
				settledAt: daysAgo(1),
			}),
			await seedDelivery(org, {
				notificationId: queued,
				destinationId: destination,
				state: "queued",
				settledAt: null,
			}),
		]

		const other = await seedOrganization("alerts-page-other")
		const otherDestination = await seedDestination(other)
		const otherCreated = await seedNotification(other, daysAgo(1))
		const otherDelivery = await seedDelivery(other, {
			notificationId: otherCreated,
			destinationId: otherDestination,
			state: "failed",
			settledAt: daysAgo(1),
		})

		const firstPage = await repo.recentFailures({ organizationId: org }, 20, 0)
		const secondPage = await repo.recentFailures({ organizationId: org }, 20, 20)
		const total = await repo.failureCount({ organizationId: org })

		expect(firstPage).toHaveLength(20)
		expect(secondPage).toHaveLength(5)
		expect(total).toBe(25)

		const firstIds = firstPage.map((row) => row.deliveryId)
		const secondIds = secondPage.map((row) => row.deliveryId)
		expect(firstIds.some((id) => secondIds.includes(id))).toBe(false)
		expect(new Set([...firstIds, ...secondIds]).size).toBe(25)

		const settledInOrder = [...firstPage, ...secondPage]
			.map((row) => row.settledAt ?? "")
			.every((value, index, all) => index === 0 || (all[index - 1] ?? "") >= value)
		expect(settledInOrder).toBe(true)

		const combinedIds = [...firstPage, ...secondPage].map((row) => row.deliveryId)
		const idsDescending = [...combinedIds].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))
		expect(combinedIds).toEqual(idsDescending)

		for (const deliveryId of notFailed) {
			expect(firstIds).not.toContain(deliveryId)
			expect(secondIds).not.toContain(deliveryId)
		}

		expect(firstIds).not.toContain(otherDelivery)
		expect(secondIds).not.toContain(otherDelivery)
		expect(await repo.failureCount({ organizationId: other })).toBe(1)
	})
})

describe("dismissing an alert that did not arrive", () => {
	it("settles it so it stops showing as outstanding", async () => {
		const destination = await seedDestination(orgA)
		const created = await seedNotification(orgA, daysAgo(1))
		const delivery = await seedDelivery(orgA, {
			notificationId: created,
			destinationId: destination,
			state: "failed",
			settledAt: daysAgo(1),
			lastError: "Server refused with 404",
		})
		const at = new Date()

		expect(await repo.dismissDelivery({ organizationId: orgA }, delivery, at)).toBe(true)

		const row = await repo.findDelivery({ organizationId: orgA }, delivery)
		expect(row?.state).toBe("abandoned")
		expect(row?.settledAt).toEqual(at)
		expect(row?.lastError).toBe("Server refused with 404")

		const found = await repo.recentFailures({ organizationId: orgA }, 20, 0)
		expect(found.map((entry) => entry.deliveryId)).not.toContain(delivery)
	})

	it("refuses to dismiss another organization's alert", async () => {
		const destination = await seedDestination(orgA)
		const created = await seedNotification(orgA, daysAgo(1))
		const delivery = await seedDelivery(orgA, {
			notificationId: created,
			destinationId: destination,
			state: "failed",
			settledAt: daysAgo(1),
		})

		expect(await repo.dismissDelivery({ organizationId: orgB }, delivery, new Date())).toBe(false)
		expect((await repo.findDelivery({ organizationId: orgA }, delivery))?.state).toBe("failed")
	})

	it("leaves an alert that is still being sent alone", async () => {
		const destination = await seedDestination(orgA)
		const created = await seedNotification(orgA, daysAgo(1))
		const delivery = await seedDelivery(orgA, {
			notificationId: created,
			destinationId: destination,
			state: "queued",
			settledAt: null,
		})

		expect(await repo.dismissDelivery({ organizationId: orgA }, delivery, new Date())).toBe(false)
		expect((await repo.findDelivery({ organizationId: orgA }, delivery))?.state).toBe("queued")
	})
})

describe("a destination's health only moves forward in time", () => {
	const scope = () => ({ organizationId: orgA })
	const EARLY = new Date("2026-09-07T12:00:00.000Z")
	const LATE = new Date("2026-09-07T12:05:00.000Z")

	const succeed = async (destination: string, at: Date) =>
		await repo.markDestinationOutcome(scope(), destination, {
			succeededAt: at,
			failedAt: null,
			reason: null,
		})

	const fail = async (destination: string, at: Date, reason: string) =>
		await repo.markDestinationOutcome(scope(), destination, {
			succeededAt: null,
			failedAt: at,
			reason,
		})

	const health = async (destination: string) => {
		const row = await repo.findDestination(scope(), destination)
		return {
			succeeded: row?.lastSucceededAt?.toISOString() ?? null,
			failed: row?.lastFailedAt?.toISOString() ?? null,
			reason: row?.lastFailureReason ?? null,
		}
	}

	it("keeps a newer success when a stale failure arrives afterwards", async () => {
		const destination = await seedDestination(orgA)
		await succeed(destination, LATE)
		await fail(destination, EARLY, "it did not go through")

		expect(await health(destination)).toEqual({
			succeeded: LATE.toISOString(),
			failed: null,
			reason: null,
		})
	})

	it("keeps a newer failure when a stale success arrives afterwards", async () => {
		const destination = await seedDestination(orgA)
		await fail(destination, LATE, "it did not go through")
		await succeed(destination, EARLY)

		expect(await health(destination)).toEqual({
			succeeded: null,
			failed: LATE.toISOString(),
			reason: "it did not go through",
		})
	})

	it("does not let a stale failure regress a newer failure's reason", async () => {
		const destination = await seedDestination(orgA)
		await fail(destination, LATE, "the certificate was not trusted")
		await fail(destination, EARLY, "the connection was refused")

		expect(await health(destination)).toMatchObject({
			failed: LATE.toISOString(),
			reason: "the certificate was not trusted",
		})
	})

	it("does not let a stale success regress a newer success", async () => {
		const destination = await seedDestination(orgA)
		await succeed(destination, LATE)
		await succeed(destination, EARLY)

		expect(await health(destination)).toMatchObject({ succeeded: LATE.toISOString() })
	})

	it("leaves the first of two writes at the same instant standing", async () => {
		const destination = await seedDestination(orgA)
		await fail(destination, LATE, "the first one recorded")
		await fail(destination, LATE, "the second one recorded")

		expect(await health(destination)).toMatchObject({ reason: "the first one recorded" })
	})

	it("still applies writes that arrive in order, in both directions", async () => {
		const failing = await seedDestination(orgA)
		await fail(failing, EARLY, "an early failure")
		await succeed(failing, LATE)
		expect(await health(failing)).toEqual({
			succeeded: LATE.toISOString(),
			failed: EARLY.toISOString(),
			reason: null,
		})

		const succeeding = await seedDestination(orgA)
		await succeed(succeeding, EARLY)
		await fail(succeeding, LATE, "a later failure")
		expect(await health(succeeding)).toEqual({
			succeeded: EARLY.toISOString(),
			failed: LATE.toISOString(),
			reason: "a later failure",
		})
	})

	it("applies a first write against a destination that has no history yet", async () => {
		const first = await seedDestination(orgA)
		await succeed(first, EARLY)
		expect(await health(first)).toMatchObject({ succeeded: EARLY.toISOString() })

		const other = await seedDestination(orgA)
		await fail(other, EARLY, "nothing recorded before this")
		expect(await health(other)).toMatchObject({ failed: EARLY.toISOString() })
	})
})
