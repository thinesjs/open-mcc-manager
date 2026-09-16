import type { Executor } from "@open-mcc/db"
import { sql } from "kysely"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
	seedMember,
	seedOrganization,
	teardownTestDb,
	testDb,
	trackHostId,
	trackInstanceConfigId,
	trackInstanceId,
} from "../test/db"
import { InstanceConcurrentlyModifiedError, takeConfigClaim } from "./instance.controller"
import {
	AUTH_LEASE_MS,
	CONFIG_CLAIM_LEASE_MS,
	createInstanceRepository,
	type InstanceUpdateValues,
	isAuthClaimStale,
} from "./instance.repository"

const repo = createInstanceRepository(testDb())
let orgA = ""
let orgB = ""
let hostA = ""

const seedHost = async (organizationId: string): Promise<string> => {
	const id = `host-${Math.random().toString(36).slice(2, 10)}`
	await testDb()
		.insertInto("host")
		.values({ id, organizationId, name: id, hostname: "10.0.0.1" })
		.execute()
	trackHostId(id)
	return id
}

let nextPort = 33333

const seedInstance = async (organizationId: string, hostId: string) => {
	nextPort += 1
	const instances = createInstanceRepository(testDb())
	const claimId = `seed-${Math.random().toString(36).slice(2, 10)}`
	const row = await instances.insert(
		{ organizationId },
		{
			hostId,
			name: `inst-${Math.random().toString(36).slice(2, 10)}`,
			minecraftAccount: "a@b.com",
			minecraftUsername: null,
			liveControlPort: nextPort,
		},
		claimId,
	)
	trackInstanceId(row.id)
	const settled = await instances.finalizeConfigClaim({ organizationId }, row.id, claimId, {})
	if (!settled) throw new Error(`Seeded instance ${row.id} kept its claim`)
	return settled
}

const backdateAuthClaim = async (id: string, ageMs: number): Promise<void> => {
	await testDb()
		.updateTable("instance")
		.set({ authClaimedAt: new Date(Date.now() - ageMs) })
		.where("id", "=", id)
		.execute()
}

const backdateConfigClaim = async (id: string, ageMs: number): Promise<void> => {
	await testDb()
		.updateTable("instance")
		.set({
			configClaimedAt: sql<Date>`clock_timestamp() - ${sql.lit(ageMs)} * interval '1 millisecond'`,
		})
		.where("id", "=", id)
		.execute()
}

const databaseNowOn = async (executor: Executor): Promise<Date> => {
	const read = await sql<{ at: Date }>`select clock_timestamp()::timestamp as at`.execute(executor)
	const row = read.rows[0]
	if (!row) throw new Error("the database returned no clock reading")
	return row.at
}

const storedInstance = async (id: string) => {
	const row = await testDb()
		.selectFrom("instance")
		.selectAll()
		.where("id", "=", id)
		.executeTakeFirst()
	if (!row) throw new Error("the seeded instance disappeared")
	return row
}

beforeAll(async () => {
	orgA = await seedOrganization("inst-a")
	orgB = await seedOrganization("inst-b")
	hostA = await seedHost(orgA)
})

afterAll(async () => {
	await teardownTestDb()
})

describe("isAuthClaimStale", () => {
	it("treats a null claim timestamp as stale so a row reaching that state stays reclaimable", () => {
		expect(isAuthClaimStale(null)).toBe(true)
	})

	it("treats a claim younger than the lease as live", () => {
		expect(isAuthClaimStale(new Date())).toBe(false)
	})

	it("treats a claim older than the lease as stale", () => {
		expect(isAuthClaimStale(new Date(Date.now() - AUTH_LEASE_MS - 1_000))).toBe(true)
	})
})

describe("instance repository organization scoping", () => {
	it("refuses to read an instance belonging to another organization", async () => {
		const row = await seedInstance(orgA, hostA)
		expect(await repo.findById({ organizationId: orgB }, row.id)).toBeUndefined()
		expect(await repo.findById({ organizationId: orgA }, row.id)).toBeDefined()
	})

	it("refuses to update an instance belonging to another organization", async () => {
		const row = await seedInstance(orgA, hostA)
		expect(await repo.update({ organizationId: orgB }, row.id, { status: "error" })).toBeUndefined()
		const unchanged = await repo.findById({ organizationId: orgA }, row.id)
		expect(unchanged?.status).toBe("created")
	})

	it("cannot be made to move an instance between organizations by a smuggled patch", async () => {
		const row = await seedInstance(orgA, hostA)
		const smuggled: InstanceUpdateValues & { organizationId: string } = {
			status: "running",
			organizationId: orgB,
		}
		await repo.update({ organizationId: orgA }, row.id, smuggled)
		const after = await repo.findById({ organizationId: orgA }, row.id)
		expect(after?.organizationId).toBe(orgA)
		expect(after?.status).toBe("running")
	})

	it("refuses to delete an instance belonging to another organization", async () => {
		const row = await seedInstance(orgA, hostA)
		expect(await repo.delete({ organizationId: orgB }, row.id)).toBe(false)
		expect(await repo.findById({ organizationId: orgA }, row.id)).toBeDefined()
	})

	it("lists only the instances of the scoped organization", async () => {
		await seedInstance(orgA, hostA)
		const listed = await repo.list({ organizationId: orgB })
		expect(listed).toEqual([])
	})

	it("refuses to claim an instance belonging to another organization for a save", async () => {
		const row = await seedInstance(orgA, hostA)
		expect(await repo.claimForConfig({ organizationId: orgB }, row.id, "claim-1")).toBeUndefined()
		expect((await storedInstance(row.id)).configClaimId).toBeNull()
	})

	it("refuses to claim an instance belonging to another organization for its lifecycle", async () => {
		const row = await seedInstance(orgA, hostA)
		expect(
			await repo.claimForLifecycle({ organizationId: orgB }, row.id, "claim-1"),
		).toBeUndefined()
		expect((await storedInstance(row.id)).configClaimId).toBeNull()
	})

	it("refuses to finalize another organization's claim, even with its claim id", async () => {
		const row = await seedInstance(orgA, hostA)
		await repo.claimForConfig({ organizationId: orgA }, row.id, "claim-1")
		expect(
			await repo.finalizeConfigClaim({ organizationId: orgB }, row.id, "claim-1", {
				status: "running",
			}),
		).toBeUndefined()
		const stored = await storedInstance(row.id)
		expect(stored.status).toBe("created")
		expect(stored.configClaimId).toBe("claim-1")
	})

	it("refuses to release another organization's claim, even with its claim id", async () => {
		const row = await seedInstance(orgA, hostA)
		await repo.claimForConfig({ organizationId: orgA }, row.id, "claim-1")
		expect(await repo.releaseConfigClaim({ organizationId: orgB }, row.id, "claim-1")).toBe(false)
		expect((await storedInstance(row.id)).configClaimId).toBe("claim-1")
	})

	it("refuses to write a token under another organization's claim, even with its claim id", async () => {
		const row = await seedInstance(orgA, hostA)
		await repo.claimForConfig({ organizationId: orgA }, row.id, "claim-1")
		expect(
			await repo.writeTokenUnderClaim({ organizationId: orgB }, row.id, "claim-1", {
				ciphertext: "sealed-token",
				keyId: "k1",
			}),
		).toBe(false)
		expect((await storedInstance(row.id)).liveControlTokenEncrypted).toBeNull()
	})

	it("refuses to delete under another organization's claim, even with its claim id", async () => {
		const row = await seedInstance(orgA, hostA)
		await repo.claimForConfig({ organizationId: orgA }, row.id, "claim-1")
		expect(await repo.deleteUnderClaim({ organizationId: orgB }, row.id, "claim-1")).toBe(false)
		expect((await storedInstance(row.id)).configClaimId).toBe("claim-1")
	})
})

describe("auth claim fencing", () => {
	it("lets exactly one of two concurrent claims win", async () => {
		const row = await seedInstance(orgA, hostA)
		const [first, second] = await Promise.all([
			repo.claimForAuth({ organizationId: orgA }, row.id, "attempt-1"),
			repo.claimForAuth({ organizationId: orgA }, row.id, "attempt-2"),
		])
		expect([first, second].filter((each) => each !== undefined)).toHaveLength(1)
	})

	it("lets a second actor reclaim a lease that has gone stale", async () => {
		const row = await seedInstance(orgA, hostA)
		await repo.claimForAuth({ organizationId: orgA }, row.id, "attempt-1")
		await backdateAuthClaim(row.id, AUTH_LEASE_MS + 60_000)
		const reclaimed = await repo.claimForAuth({ organizationId: orgA }, row.id, "attempt-2")
		expect(reclaimed?.authClaimId).toBe("attempt-2")
	})

	it("releases only when the attempt id matches, so a superseded attempt cannot release a live claim", async () => {
		const row = await seedInstance(orgA, hostA)
		await repo.claimForAuth({ organizationId: orgA }, row.id, "attempt-1")
		expect(await repo.releaseAuthClaim({ organizationId: orgA }, row.id, "attempt-stale")).toBe(
			false,
		)
		expect(await repo.releaseAuthClaim({ organizationId: orgA }, row.id, "attempt-1")).toBe(true)
	})
})

describe("config claim fencing", () => {
	it("refuses a second claimant while the first claim is live", async () => {
		const row = await seedInstance(orgA, hostA)
		const first = await repo.claimForConfig({ organizationId: orgA }, row.id, "claim-1")
		const second = await repo.claimForConfig({ organizationId: orgA }, row.id, "claim-2")
		expect(first?.configClaimId).toBe("claim-1")
		expect(second).toBeUndefined()
		expect((await storedInstance(row.id)).configClaimId).toBe("claim-1")
	})

	it("reclaims under a new id once the claim is backdated past its lease", async () => {
		const row = await seedInstance(orgA, hostA)
		await repo.claimForConfig({ organizationId: orgA }, row.id, "claim-1")
		await backdateConfigClaim(row.id, CONFIG_CLAIM_LEASE_MS + 60_000)
		const reclaimed = await repo.claimForConfig({ organizationId: orgA }, row.id, "claim-2")
		expect(reclaimed?.configClaimId).toBe("claim-2")
	})
})

describe("a new bot is claimed by the statement that makes it visible", () => {
	const insertClaimedOn = async (executor: Executor, claimId: string) => {
		nextPort += 1
		const row = await createInstanceRepository(executor).insert(
			{ organizationId: orgA },
			{
				hostId: hostA,
				name: `inst-${Math.random().toString(36).slice(2, 10)}`,
				minecraftAccount: "a@b.com",
				minecraftUsername: null,
				liveControlPort: nextPort,
			},
			claimId,
		)
		trackInstanceId(row.id)
		return row
	}

	const insertClaimed = async (claimId: string) => await insertClaimedOn(testDb(), claimId)

	it("returns the row already holding the claim it was inserted under", async () => {
		const row = await insertClaimed("create-1")
		expect(row.configClaimId).toBe("create-1")
		expect((await storedInstance(row.id)).configClaimId).toBe("create-1")
	})

	it("refuses another claimant from the moment the row exists", async () => {
		const row = await insertClaimed("create-1")
		expect(await repo.claimForConfig({ organizationId: orgA }, row.id, "other")).toBeUndefined()
		expect(await repo.claimForLifecycle({ organizationId: orgA }, row.id, "other")).toBeUndefined()
		expect(await repo.claimForAuth({ organizationId: orgA }, row.id, "sign-in")).toBeUndefined()
	})

	it("leases that claim, so a creation that never finished is reclaimable", async () => {
		const row = await insertClaimed("create-1")
		await backdateConfigClaim(row.id, CONFIG_CLAIM_LEASE_MS + 60_000)
		expect(
			(await repo.claimForConfig({ organizationId: orgA }, row.id, "other"))?.configClaimId,
		).toBe("other")
	})

	it("stamps the claim from the database clock, not the clock the server runs on", async () => {
		const oneHourOffTheServer = 1 - new Date().getTimezoneOffset() / 60

		const { before, stamped, after } = await testDb()
			.transaction()
			.execute(async (tx) => {
				await sql`set local time zone interval ${sql.lit(`${oneHourOffTheServer} hours`)}`.execute(
					tx,
				)
				const before = await databaseNowOn(tx)
				const row = await insertClaimedOn(tx, "create-1")
				const after = await databaseNowOn(tx)
				return { before, stamped: row.configClaimedAt, after }
			})

		expect(stamped).toBeInstanceOf(Date)
		expect(stamped?.getTime()).toBeGreaterThanOrEqual(before.getTime())
		expect(stamped?.getTime()).toBeLessThanOrEqual(after.getTime())
	})
})

describe("writes under a config claim match the claim id", () => {
	const seedClaimed = async (): Promise<string> => {
		const row = await seedInstance(orgA, hostA)
		await repo.claimForConfig({ organizationId: orgA }, row.id, "claim-1")
		return row.id
	}

	it("finalizes nothing under the wrong claim id", async () => {
		const id = await seedClaimed()
		expect(
			await repo.finalizeConfigClaim({ organizationId: orgA }, id, "claim-other", {
				status: "running",
			}),
		).toBeUndefined()
		const stored = await storedInstance(id)
		expect(stored.status).toBe("created")
		expect(stored.configClaimId).toBe("claim-1")
	})

	it("releases nothing under the wrong claim id", async () => {
		const id = await seedClaimed()
		expect(await repo.releaseConfigClaim({ organizationId: orgA }, id, "claim-other")).toBe(false)
		expect((await storedInstance(id)).configClaimId).toBe("claim-1")
	})

	it("writes no token under the wrong claim id", async () => {
		const id = await seedClaimed()
		expect(
			await repo.writeTokenUnderClaim({ organizationId: orgA }, id, "claim-other", {
				ciphertext: "sealed-token",
				keyId: "k1",
			}),
		).toBe(false)
		expect((await storedInstance(id)).liveControlTokenEncrypted).toBeNull()
	})

	it("deletes nothing under the wrong claim id", async () => {
		const id = await seedClaimed()
		expect(await repo.deleteUnderClaim({ organizationId: orgA }, id, "claim-other")).toBe(false)
		expect((await storedInstance(id)).configClaimId).toBe("claim-1")
	})

	it("finalizes under the holder's claim id, clearing the lease and writing the status", async () => {
		const id = await seedClaimed()
		const finalized = await repo.finalizeConfigClaim({ organizationId: orgA }, id, "claim-1", {
			status: "running",
		})
		expect(finalized?.status).toBe("running")
		const stored = await storedInstance(id)
		expect(stored.status).toBe("running")
		expect(stored.configClaimId).toBeNull()
		expect(stored.configClaimedAt).toBeNull()
	})

	it("releases under the holder's claim id, leaving the row claimable again", async () => {
		const id = await seedClaimed()
		expect(await repo.releaseConfigClaim({ organizationId: orgA }, id, "claim-1")).toBe(true)
		const stored = await storedInstance(id)
		expect(stored.configClaimId).toBeNull()
		expect(stored.configClaimedAt).toBeNull()
		expect(
			(await repo.claimForConfig({ organizationId: orgA }, id, "claim-2"))?.configClaimId,
		).toBe("claim-2")
	})

	it("deletes under the holder's claim id", async () => {
		const id = await seedClaimed()
		expect(await repo.deleteUnderClaim({ organizationId: orgA }, id, "claim-1")).toBe(true)
		expect(await repo.findById({ organizationId: orgA }, id)).toBeUndefined()
	})
})

describe("sign-in and the lifecycle exclude each other", () => {
	it("refuses a lifecycle claim while a sign-in claim is live, and still takes a save's claim", async () => {
		const row = await seedInstance(orgA, hostA)
		await repo.claimForAuth({ organizationId: orgA }, row.id, "attempt-1")
		expect(
			await repo.claimForLifecycle({ organizationId: orgA }, row.id, "claim-1"),
		).toBeUndefined()
		const saved = await repo.claimForConfig({ organizationId: orgA }, row.id, "claim-1")
		expect(saved?.configClaimId).toBe("claim-1")
	})

	it("takes the lifecycle claim once the sign-in claim is backdated past its lease", async () => {
		const row = await seedInstance(orgA, hostA)
		await repo.claimForAuth({ organizationId: orgA }, row.id, "attempt-1")
		await backdateAuthClaim(row.id, AUTH_LEASE_MS + 60_000)
		const claimed = await repo.claimForLifecycle({ organizationId: orgA }, row.id, "claim-1")
		expect(claimed?.configClaimId).toBe("claim-1")
	})

	it("refuses a lifecycle claim while a config claim is live", async () => {
		const row = await seedInstance(orgA, hostA)
		await repo.claimForConfig({ organizationId: orgA }, row.id, "claim-1")
		expect(
			await repo.claimForLifecycle({ organizationId: orgA }, row.id, "claim-2"),
		).toBeUndefined()
		expect((await storedInstance(row.id)).configClaimId).toBe("claim-1")
	})

	it("takes the lifecycle claim once the config claim is backdated past its lease", async () => {
		const row = await seedInstance(orgA, hostA)
		await repo.claimForConfig({ organizationId: orgA }, row.id, "claim-1")
		await backdateConfigClaim(row.id, CONFIG_CLAIM_LEASE_MS + 60_000)
		const claimed = await repo.claimForLifecycle({ organizationId: orgA }, row.id, "claim-2")
		expect(claimed?.configClaimId).toBe("claim-2")
	})

	it("refuses a sign-in claim while a config claim is live", async () => {
		const row = await seedInstance(orgA, hostA)
		await repo.claimForConfig({ organizationId: orgA }, row.id, "claim-1")
		expect(await repo.claimForAuth({ organizationId: orgA }, row.id, "attempt-1")).toBeUndefined()
	})

	it("takes the sign-in claim once the config claim is backdated past its lease", async () => {
		const row = await seedInstance(orgA, hostA)
		await repo.claimForConfig({ organizationId: orgA }, row.id, "claim-1")
		await backdateConfigClaim(row.id, CONFIG_CLAIM_LEASE_MS + 60_000)
		const claimed = await repo.claimForAuth({ organizationId: orgA }, row.id, "attempt-1")
		expect(claimed?.authClaimId).toBe("attempt-1")
	})

	it("clears the config claim it takes over, so the superseded finalize matches nothing", async () => {
		const row = await seedInstance(orgA, hostA)
		await repo.claimForConfig({ organizationId: orgA }, row.id, "claim-1")
		await backdateConfigClaim(row.id, CONFIG_CLAIM_LEASE_MS + 60_000)
		const claimed = await repo.claimForAuth({ organizationId: orgA }, row.id, "attempt-1")
		expect(claimed?.configClaimId).toBeNull()
		expect(
			await repo.finalizeConfigClaim({ organizationId: orgA }, row.id, "claim-1", {
				status: "running",
			}),
		).toBeUndefined()
		expect((await storedInstance(row.id)).status).toBe("created")
	})
})

describe("the token write renews the config lease", () => {
	it("renews the lease, so a competing claim is refused after the write", async () => {
		const row = await seedInstance(orgA, hostA)
		await repo.claimForConfig({ organizationId: orgA }, row.id, "claim-1")
		await backdateConfigClaim(row.id, CONFIG_CLAIM_LEASE_MS + 60_000)
		expect(
			await repo.writeTokenUnderClaim({ organizationId: orgA }, row.id, "claim-1", {
				ciphertext: "sealed-token",
				keyId: "k1",
			}),
		).toBe(true)
		const stored = await storedInstance(row.id)
		expect(stored.liveControlTokenEncrypted).toBe("sealed-token")
		expect(stored.liveControlTokenKeyId).toBe("k1")
		expect(await repo.claimForConfig({ organizationId: orgA }, row.id, "claim-2")).toBeUndefined()
	})

	it("neither writes nor renews under the wrong claim id", async () => {
		const row = await seedInstance(orgA, hostA)
		await repo.claimForConfig({ organizationId: orgA }, row.id, "claim-1")
		await backdateConfigClaim(row.id, CONFIG_CLAIM_LEASE_MS + 60_000)
		expect(
			await repo.writeTokenUnderClaim({ organizationId: orgA }, row.id, "claim-other", {
				ciphertext: "sealed-token",
				keyId: "k1",
			}),
		).toBe(false)
		expect((await storedInstance(row.id)).liveControlTokenEncrypted).toBeNull()
		expect(
			(await repo.claimForConfig({ organizationId: orgA }, row.id, "claim-2"))?.configClaimId,
		).toBe("claim-2")
	})
})

describe("versioned config", () => {
	it("numbers versions from one and returns the latest", async () => {
		const row = await seedInstance(orgA, hostA)
		const member = await seedMember(orgA)
		const first = await repo.insertConfigVersion(
			{ organizationId: orgA },
			row.id,
			JSON.stringify({ serverAddress: "one.example.com" }),
			{ authorId: member, authorLabel: "author@example.com" },
		)
		trackInstanceConfigId(first.id)
		const second = await repo.insertConfigVersion(
			{ organizationId: orgA },
			row.id,
			JSON.stringify({ serverAddress: "two.example.com" }),
			{ authorId: member, authorLabel: "author@example.com" },
		)
		trackInstanceConfigId(second.id)

		expect(first.version).toBe(1)
		expect(second.version).toBe(2)
		const latest = await repo.latestConfig({ organizationId: orgA }, row.id)
		expect(latest?.version).toBe(2)
	})

	it("does not return another organization's config", async () => {
		const row = await seedInstance(orgA, hostA)
		const cfg = await repo.insertConfigVersion(
			{ organizationId: orgA },
			row.id,
			JSON.stringify({ serverAddress: "one.example.com" }),
			{ authorId: null, authorLabel: "author@example.com" },
		)
		trackInstanceConfigId(cfg.id)
		expect(await repo.latestConfig({ organizationId: orgB }, row.id)).toBeUndefined()
	})
})

describe("takeConfigClaim against a finalize still holding the row", () => {
	const waitingPids = async (pid: number): Promise<number> => {
		const answer = await sql<{
			blocked: number
		}>`select count(*)::int as blocked from pg_locks where pid = ${pid} and not granted`.execute(
			testDb(),
		)
		return answer.rows[0]?.blocked ?? 0
	}

	const backendPid = async (tx: Executor): Promise<number> => {
		const answer = await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(tx)
		return answer.rows[0]?.pid ?? 0
	}

	it("claims before it compares, so it never reads a version an open finalize is replacing", async () => {
		const member = await seedMember(orgA)
		const scope = { organizationId: orgA }
		const row = await seedInstance(orgA, hostA)
		const first = await repo.insertConfigVersion(
			scope,
			row.id,
			JSON.stringify({ serverAddress: "one.example.com" }),
			{ authorId: member, authorLabel: "author@example.com" },
		)
		trackInstanceConfigId(first.id)
		await repo.claimForConfig(scope, row.id, "claim-a")
		await backdateConfigClaim(row.id, CONFIG_CLAIM_LEASE_MS + 60_000)

		let releaseFinalize = (): void => undefined
		const held = new Promise<void>((resolve) => {
			releaseFinalize = resolve
		})

		const finalizing = testDb()
			.transaction()
			.execute(async (tx) => {
				const inTransaction = createInstanceRepository(tx)
				await inTransaction.finalizeConfigClaim(scope, row.id, "claim-a", {})
				const second = await inTransaction.insertConfigVersion(
					scope,
					row.id,
					JSON.stringify({ serverAddress: "two.example.com" }),
					{ authorId: member, authorLabel: "author@example.com" },
				)
				trackInstanceConfigId(second.id)
				await held
			})

		let claimingPid = 0
		const claiming = testDb()
			.transaction()
			.execute(async (tx) => {
				claimingPid = await backendPid(tx)
				return await takeConfigClaim(
					{ instances: createInstanceRepository(tx) },
					scope,
					row.id,
					"claim-b",
					{ expectedVersion: 1 },
				)
			})

		let blocked = 0
		try {
			for (let attempt = 0; attempt < 500 && blocked === 0; attempt += 1) {
				blocked = await waitingPids(claimingPid)
			}
		} finally {
			releaseFinalize()
		}

		await finalizing
		const settled = await claiming.then(
			() => "the claim was allowed",
			(error: Error) => error,
		)

		expect(blocked).toBeGreaterThan(0)
		expect(settled).toBeInstanceOf(InstanceConcurrentlyModifiedError)
		expect((await repo.latestConfig(scope, row.id))?.version).toBe(2)
	})
})
