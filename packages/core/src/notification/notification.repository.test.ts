import type { DestinationKind, SubscriptionKind } from "@open-mcc/db"
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
