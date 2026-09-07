import { describe, expect, it } from "vitest"
import {
	configuredAs,
	NOTIFICATION_DEADLETTER_QUEUE,
	NOTIFICATION_EMAIL_QUEUE,
	NOTIFICATION_HTTP_QUEUE,
	NOTIFICATION_QUEUE_POLICIES,
	orderedForCreation,
	type QueueAdmin,
	type QueueCreateOptions,
	type QueuePolicy,
	type QueueUpdateOptions,
	reconcileQueues,
	type StoredQueue,
} from "./queue-setup"

const PG_BOSS_DEFAULTS: StoredQueue = {
	retryLimit: 2,
	retryDelay: 0,
	retryBackoff: false,
	retryDelayMax: null,
	expireInSeconds: 15 * 60,
	retentionSeconds: 14 * 24 * 60 * 60,
	deleteAfterSeconds: 7 * 24 * 60 * 60,
	deadLetter: null,
	warningQueueSize: 0,
	heartbeatSeconds: null,
	notify: false,
}

const rejectsWhatPgBossRejects = (options: QueueCreateOptions | QueueUpdateOptions): void => {
	if (!("retryDelayMax" in options)) return
	if (options.retryDelayMax === null || options.retryDelayMax === undefined) return
	if (options.retryBackoff !== true)
		throw new Error("retryDelayMax can only be set if retryBackoff is true")
}

const fakePgBoss = () => {
	const stored = new Map<string, StoredQueue>()
	const created: string[] = []
	const updated: { name: string; options: QueueUpdateOptions }[] = []

	const admin: QueueAdmin = {
		createQueue: async (name, options) => {
			rejectsWhatPgBossRejects(options)
			if (options.deadLetter !== undefined && !stored.has(options.deadLetter))
				throw new Error(`queue ${options.deadLetter} does not exist`)
			created.push(name)
			if (stored.has(name)) return
			stored.set(name, {
				...PG_BOSS_DEFAULTS,
				retryLimit: options.retryLimit,
				retryDelay: options.retryDelay,
				retryBackoff: options.retryBackoff,
				expireInSeconds: options.expireInSeconds,
				retentionSeconds: options.retentionSeconds,
				deleteAfterSeconds: options.deleteAfterSeconds,
				retryDelayMax: options.retryDelayMax ?? null,
				deadLetter: options.deadLetter ?? null,
			})
		},
		updateQueue: async (name, options) => {
			rejectsWhatPgBossRejects(options)
			updated.push({ name, options })
			const row = stored.get(name)
			if (row === undefined) throw new Error(`queue ${name} does not exist`)
			stored.set(name, { ...row, ...options })
		},
		getQueue: async (name) => stored.get(name) ?? null,
	}

	return { admin, created, updated, stored }
}

const policyNamed = (name: string): QueuePolicy => {
	const policy = NOTIFICATION_QUEUE_POLICIES.find((candidate) => candidate.name === name)
	if (policy === undefined) throw new Error(`no policy named ${name}`)
	return policy
}

describe("setting the queues up", () => {
	it("creates the dead-letter queue before anything that points at it", () => {
		const order = orderedForCreation(NOTIFICATION_QUEUE_POLICIES).map((policy) => policy.name)
		expect(order[0]).toBe(NOTIFICATION_DEADLETTER_QUEUE)
		expect(order).toContain(NOTIFICATION_HTTP_QUEUE)
		expect(order).toContain(NOTIFICATION_EMAIL_QUEUE)
	})

	it("updates every queue as well as creating it, because creating one that exists does nothing", async () => {
		const { admin, created, updated } = fakePgBoss()
		await reconcileQueues(admin)

		expect(created).toHaveLength(NOTIFICATION_QUEUE_POLICIES.length)
		expect(updated.map((entry) => entry.name)).toEqual(created)
	})

	it("leaves every queue configured the way the policy asks, run after run", async () => {
		const { admin, stored } = fakePgBoss()
		await reconcileQueues(admin)
		await reconcileQueues(admin)

		for (const policy of NOTIFICATION_QUEUE_POLICIES) {
			expect(stored.get(policy.name)).toEqual(configuredAs(policy))
		}
	})

	it("leaves retrying to us, because only we know what a provider asked us to wait", async () => {
		const { admin, stored } = fakePgBoss()
		await reconcileQueues(admin)

		const http = stored.get(NOTIFICATION_HTTP_QUEUE)
		expect(http?.retryLimit).toBe(0)
		expect(http?.retryBackoff).toBe(false)
		expect(http?.retryDelayMax).toBeNull()
		expect(http?.expireInSeconds).toBe(5 * 60)
	})

	it("still points a delivery queue at the dead-letter queue, so an unexpected throw is kept", async () => {
		const { admin, stored } = fakePgBoss()
		await reconcileQueues(admin)

		expect(stored.get(NOTIFICATION_HTTP_QUEUE)?.deadLetter).toBe(NOTIFICATION_DEADLETTER_QUEUE)
		expect(stored.get(NOTIFICATION_EMAIL_QUEUE)?.deadLetter).toBe(NOTIFICATION_DEADLETTER_QUEUE)
	})

	it("asks for no maximum retry delay on the dead-letter queue, which pg-boss refuses next to a fixed delay", async () => {
		const dead = policyNamed(NOTIFICATION_DEADLETTER_QUEUE)
		expect(dead.retryBackoff).toBe(false)
		expect(dead.retryDelayMax).toBeNull()

		const { admin, stored } = fakePgBoss()
		await expect(reconcileQueues(admin)).resolves.toBeUndefined()
		expect(stored.get(NOTIFICATION_DEADLETTER_QUEUE)?.retryDelayMax).toBeNull()
	})

	it("does not send the dead-letter queue to itself", async () => {
		const { admin, stored } = fakePgBoss()
		await reconcileQueues(admin)

		expect(stored.get(NOTIFICATION_DEADLETTER_QUEUE)?.deadLetter).toBeNull()
		expect(stored.get(NOTIFICATION_DEADLETTER_QUEUE)?.retryLimit).toBe(0)
	})

	it("keeps a delivery for a fortnight and a dead letter for a month", () => {
		const day = 24 * 60 * 60
		for (const name of [NOTIFICATION_HTTP_QUEUE, NOTIFICATION_EMAIL_QUEUE]) {
			const policy = policyNamed(name)
			expect(policy.retentionSeconds).toBe(14 * day)
			expect(policy.deleteAfterSeconds).toBe(14 * day)
		}

		const dead = policyNamed(NOTIFICATION_DEADLETTER_QUEUE)
		expect(dead.retentionSeconds).toBe(30 * day)
		expect(dead.deleteAfterSeconds).toBe(30 * day)
	})

	it("refuses to carry on if a queue is not actually there afterwards", async () => {
		const { admin } = fakePgBoss()
		const blind: QueueAdmin = {
			...admin,
			getQueue: async (name) =>
				name === NOTIFICATION_HTTP_QUEUE ? null : await admin.getQueue(name),
		}

		await expect(reconcileQueues(blind)).rejects.toThrow(NOTIFICATION_HTTP_QUEUE)
	})

	it("names the queue and the setting when a stored queue disagrees with the policy", async () => {
		const { admin } = fakePgBoss()
		const forgetful: QueueAdmin = {
			...admin,
			getQueue: async (name) => {
				const row = await admin.getQueue(name)
				if (row === null || name !== NOTIFICATION_EMAIL_QUEUE) return row
				return { ...row, retentionSeconds: 7 * 24 * 60 * 60 }
			},
		}

		await expect(reconcileQueues(forgetful)).rejects.toThrow(NOTIFICATION_EMAIL_QUEUE)
		await expect(reconcileQueues(forgetful)).rejects.toThrow("retentionSeconds")
	})

	it("keeps every queue's rows around long enough to investigate a failure", () => {
		for (const policy of NOTIFICATION_QUEUE_POLICIES) {
			expect(policy.retentionSeconds).toBeGreaterThan(0)
			expect(policy.deleteAfterSeconds).toBeGreaterThan(0)
			expect(policy.expireInSeconds).toBeGreaterThan(0)
		}
	})
})
