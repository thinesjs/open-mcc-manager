import type { CreateHostInput, HostPublic, Role, SelfHostOffer } from "@open-mcc/contracts"
import type { HostRow, SshKeyRow } from "@open-mcc/db"
import { describe, expect, it, vi } from "vitest"
import type { AuditEntry } from "../audit/audit.repository"
import { type ActorContext, ForbiddenError } from "../host/host.controller"
import type { SshKeyCreateValues } from "../ssh-key/ssh-key.repository"
import {
	createSelfHostController,
	type SelfHostControllerDeps,
	type SelfHostMaterials,
	SelfHostUnavailableError,
} from "./self-host.controller"

const FINGERPRINT = "SHA256:abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ"
const PUBLIC_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA open-mcc:this-machine"
const SEALED = "sealed-ciphertext-that-must-never-reach-a-browser"

const actor = (role: Role): ActorContext => ({
	organizationId: "org-1",
	memberId: "mem-1",
	actorLabel: "owner@example.com",
	role,
})

const makeOffer = (overrides: Partial<SelfHostOffer> = {}): SelfHostOffer => ({
	name: "kitchen-pi",
	hostname: "host.docker.internal",
	port: 22,
	username: "mcc",
	fingerprint: FINGERPRINT,
	reach: "proven",
	systemd: true,
	linger: true,
	...overrides,
})

const makeMaterials = (offer: SelfHostOffer = makeOffer()): SelfHostMaterials => ({
	offer,
	publicKey: PUBLIC_KEY,
	privateKeyEncrypted: SEALED,
	privateKeyKeyId: "k1",
})

const makeSshKeyRow = (overrides: Partial<SshKeyRow> = {}): SshKeyRow => ({
	id: "key-1",
	organizationId: "org-1",
	name: "kitchen-pi",
	publicKey: PUBLIC_KEY,
	privateKeyEncrypted: SEALED,
	privateKeyKeyId: "k1",
	createdAt: new Date("2026-09-13T00:00:00.000Z"),
	...overrides,
})

const makeHostRow = (): HostRow => ({
	id: "host-1",
	organizationId: "org-1",
	name: "kitchen-pi",
	hostname: "host.docker.internal",
	port: 22,
	username: "mcc",
	networkStack: null,
	architecture: null,
	osId: null,
	osName: null,
	failedUnits: null,
	teardownError: null,
	teardownRequestedAt: null,
	sshKeyId: "key-1",
	hostKeyAlgorithm: "ssh-ed25519",
	hostKeyFingerprint: FINGERPRINT,
	hostKeyTrustedBy: "mem-1",
	hostKeyTrustedByLabel: "owner@example.com",
	hostKeyTrustedAt: new Date("2026-09-13T00:00:00.000Z"),
	status: "pending",
	provisioningAttemptId: null,
	provisioningClaimedAt: null,
	provisioningStep: null,
	provisioningStepIndex: null,
	provisioningStepTotal: null,
	provisioningError: null,
	osRelease: null,
	cpuCount: null,
	memoryMb: null,
	lastSeenAt: null,
	createdAt: new Date("2026-09-13T00:00:00.000Z"),
})

const makeHostPublic = (): HostPublic => {
	const row = makeHostRow()
	return {
		...row,
		hostKeyTrustedAt: row.hostKeyTrustedAt?.toISOString() ?? null,
		lastSeenAt: row.lastSeenAt?.toISOString() ?? null,
		teardownRequestedAt: row.teardownRequestedAt?.toISOString() ?? null,
	}
}

type Harness = {
	deps: SelfHostControllerDeps
	inserted: SshKeyCreateValues[]
	audited: AuditEntry[]
	enrolled: CreateHostInput[]
}

const harness = (materials: SelfHostMaterials | undefined, stored: SshKeyRow[] = []): Harness => {
	const inserted: SshKeyCreateValues[] = []
	const audited: AuditEntry[] = []
	const enrolled: CreateHostInput[] = []

	const deps: SelfHostControllerDeps = {
		materials,
		sshKeys: { list: vi.fn(async () => stored) },
		withSshKeyTransaction: (fn) =>
			fn({
				sshKeys: {
					insert: vi.fn(async (_scope, values: SshKeyCreateValues) => {
						inserted.push(values)
						return makeSshKeyRow({ id: "key-new", ...values })
					}),
					delete: vi.fn(async () => true),
				},
				audit: {
					record: vi.fn(async (_scope, entry: AuditEntry) => {
						audited.push(entry)
						return {
							id: "audit-1",
							organizationId: "org-1",
							actorId: entry.actorId,
							actorLabel: entry.actorLabel,
							action: entry.action,
							subjectType: entry.subjectType,
							subjectId: entry.subjectId,
							detail: entry.detail,
							createdAt: new Date("2026-09-13T00:00:00.000Z"),
						}
					}),
				},
			}),
		enroll: vi.fn(async (_ctx: ActorContext, input: CreateHostInput) => {
			enrolled.push(input)
			return makeHostPublic()
		}),
	}

	return { deps, inserted, audited, enrolled }
}

describe("what the dashboard is offered", () => {
	it("gives an enroller the machine this deployment was installed on", async () => {
		const controller = createSelfHostController(harness(makeMaterials()).deps)

		expect(await controller.offer(actor("owner"))).toEqual({
			name: "kitchen-pi",
			hostname: "host.docker.internal",
			port: 22,
			username: "mcc",
			reach: "proven",
			systemd: true,
			linger: true,
		})
	})

	it("★ never hands the browser a host key, which it must never be the source of", async () => {
		const controller = createSelfHostController(harness(makeMaterials()).deps)
		const offered = await controller.offer(actor("owner"))

		expect(JSON.stringify(offered)).not.toContain(FINGERPRINT)
	})

	it("offers nothing to a member who could not act on it", async () => {
		const controller = createSelfHostController(harness(makeMaterials()).deps)

		expect(await controller.offer(actor("viewer"))).toBeUndefined()
		expect(await controller.offer(actor("operator"))).toBeUndefined()
	})

	it("offers nothing when the installer left no materials behind", async () => {
		const controller = createSelfHostController(harness(undefined).deps)

		expect(await controller.offer(actor("owner"))).toBeUndefined()
	})

	it("never carries the sealed private key, which the browser has no business holding", async () => {
		const controller = createSelfHostController(harness(makeMaterials()).deps)
		const offered = await controller.offer(actor("owner"))

		expect(JSON.stringify(offered)).not.toContain(SEALED)
		expect(JSON.stringify(offered)).not.toContain("k1")
	})
})

describe("adding this machine", () => {
	it("refuses a member who cannot enroll a host", async () => {
		const controller = createSelfHostController(harness(makeMaterials()).deps)

		await expect(controller.adopt(actor("operator"))).rejects.toBeInstanceOf(ForbiddenError)
		await expect(controller.adopt(actor("viewer"))).rejects.toBeInstanceOf(ForbiddenError)
	})

	it("refuses when the installer left no materials behind", async () => {
		const controller = createSelfHostController(harness(undefined).deps)

		await expect(controller.adopt(actor("owner"))).rejects.toBeInstanceOf(SelfHostUnavailableError)
	})

	it.each([{ reach: "reachable" as const }, { reach: "unproven" as const }])(
		"refuses when no container proved it could reach the machine, $reach",
		async ({ reach }) => {
			const built = harness(makeMaterials(makeOffer({ reach })))
			const controller = createSelfHostController(built.deps)

			await expect(controller.adopt(actor("owner"))).rejects.toBeInstanceOf(
				SelfHostUnavailableError,
			)
			expect(built.enrolled).toEqual([])
		},
	)

	it("refuses a machine with no systemd, which could never run an instance", async () => {
		const built = harness(makeMaterials(makeOffer({ systemd: false })))
		const controller = createSelfHostController(built.deps)

		await expect(controller.adopt(actor("owner"))).rejects.toBeInstanceOf(SelfHostUnavailableError)
		expect(built.enrolled).toEqual([])
	})

	it("adds a machine whose lingering is off, because that is one command away rather than a dead end", async () => {
		const built = harness(makeMaterials(makeOffer({ linger: false })))
		const controller = createSelfHostController(built.deps)

		await controller.adopt(actor("owner"))

		expect(built.enrolled).toHaveLength(1)
	})

	it("stores the key already sealed, so no second private key is ever generated", async () => {
		const built = harness(makeMaterials())
		const controller = createSelfHostController(built.deps)

		await controller.adopt(actor("owner"))

		expect(built.inserted).toEqual([
			{
				name: "kitchen-pi",
				publicKey: PUBLIC_KEY,
				privateKeyEncrypted: SEALED,
				privateKeyKeyId: "k1",
			},
		])
	})

	it("records the key it stored against the member who asked for it", async () => {
		const built = harness(makeMaterials())
		const controller = createSelfHostController(built.deps)

		await controller.adopt(actor("owner"))

		expect(built.audited).toEqual([
			{
				actorId: "mem-1",
				actorLabel: "owner@example.com",
				action: "sshKey.create",
				subjectType: "sshKey",
				subjectId: "key-new",
				detail: { name: "kitchen-pi", origin: "self-host" },
			},
		])
	})

	it("hands enrolment the address and fingerprint from the deployment's own configuration", async () => {
		const built = harness(makeMaterials())
		const controller = createSelfHostController(built.deps)

		await controller.adopt(actor("owner"))

		expect(built.enrolled).toEqual([
			{
				name: "kitchen-pi",
				hostname: "host.docker.internal",
				port: 22,
				username: "mcc",
				sshKeyId: "key-new",
				expectedFingerprint: FINGERPRINT,
			},
		])
	})

	it("lets enrolment fail on its own terms rather than swallowing what it found", async () => {
		const built = harness(makeMaterials())
		const refused = new Error("fingerprint mismatch")
		built.deps.enroll = async () => {
			throw refused
		}
		const controller = createSelfHostController(built.deps)

		await expect(controller.adopt(actor("owner"))).rejects.toBe(refused)
	})

	it("reuses the key it already stored, so a retry after a failed enrolment is not blocked", async () => {
		const built = harness(makeMaterials(), [makeSshKeyRow()])
		const controller = createSelfHostController(built.deps)

		await controller.adopt(actor("owner"))

		expect(built.inserted).toEqual([])
		expect(built.audited).toEqual([])
		expect(built.enrolled[0]?.sshKeyId).toBe("key-1")
	})

	it("does not mistake another key in the organization for its own", async () => {
		const other = makeSshKeyRow({ id: "key-other", publicKey: "ssh-ed25519 AAAAsomeoneelse" })
		const built = harness(makeMaterials(), [other])
		const controller = createSelfHostController(built.deps)

		await controller.adopt(actor("owner"))

		expect(built.inserted).toHaveLength(1)
		expect(built.enrolled[0]?.sshKeyId).toBe("key-new")
	})
})
