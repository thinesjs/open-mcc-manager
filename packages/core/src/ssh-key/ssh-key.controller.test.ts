import type { Role } from "@open-mcc/contracts"
import type { SshKeyRow } from "@open-mcc/db"
import { describe, expect, it, vi } from "vitest"
import type { AuditEntry } from "../audit/audit.repository"
import { type ActorContext, ForbiddenError } from "../host/host.controller"
import {
	createSshKeyController,
	type SshKeyControllerDeps,
	type SshKeyTransactionRepos,
} from "./ssh-key.controller"

const PLAINTEXT_PRIVATE_KEY = "-----BEGIN OPENSSH PRIVATE KEY-----marker-----END-----"
const SEALED_CIPHERTEXT = "sealed-ciphertext-that-must-never-reach-a-client"
const SEALBOX_KEY_ID = "sealbox-key-identifier"

const actor = (role: Role): ActorContext => ({
	organizationId: "org-1",
	memberId: "mem-1",
	actorLabel: "owner@example.com",
	role,
})

const storedRow = (overrides: Partial<SshKeyRow> = {}): SshKeyRow => ({
	id: "key-1",
	organizationId: "org-1",
	name: "deploy",
	publicKey: "ssh-ed25519 AAAApublic",
	privateKeyEncrypted: SEALED_CIPHERTEXT,
	privateKeyKeyId: SEALBOX_KEY_ID,
	createdAt: new Date("2026-08-30T00:00:00.000Z"),
	...overrides,
})

type Harness = {
	deps: SshKeyControllerDeps
	repos: SshKeyTransactionRepos
	audited: AuditEntry[]
	transactions: number
}

const harness = (overrides: Partial<SshKeyTransactionRepos> = {}): Harness => {
	const audited: AuditEntry[] = []
	const repos: SshKeyTransactionRepos = {
		sshKeys: {
			insert: vi.fn(async () => storedRow()),
			delete: vi.fn(async () => true),
			...overrides.sshKeys,
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
					createdAt: new Date("2026-08-30T00:00:00.000Z"),
				}
			}),
			...overrides.audit,
		},
	}
	const state = { transactions: 0 }
	const deps: SshKeyControllerDeps = {
		sshKeys: { list: vi.fn(async () => [storedRow()]) },
		secrets: {
			seal: vi.fn(() => ({ ciphertext: SEALED_CIPHERTEXT, keyId: SEALBOX_KEY_ID })),
		},
		generateKeyPair: vi.fn((_name: string) => ({
			publicKey: "ssh-ed25519 AAAApublic",
			privateKey: PLAINTEXT_PRIVATE_KEY,
		})),
		withTransaction: (fn) => {
			state.transactions += 1
			return fn(repos)
		},
	}
	return {
		deps,
		repos,
		audited,
		get transactions() {
			return state.transactions
		},
	}
}

describe("sshKeyController.create", () => {
	it("returns only the public projection, never the sealed private key material", async () => {
		const { deps } = harness()
		const created = await createSshKeyController(deps).create(actor("owner"), {
			name: "deploy",
			type: "ed25519",
		})

		expect(Object.keys(created).sort()).toEqual(["createdAt", "id", "name", "publicKey"])
		const serialized = JSON.stringify(created)
		expect(serialized).not.toContain(SEALED_CIPHERTEXT)
		expect(serialized).not.toContain(SEALBOX_KEY_ID)
		expect(serialized).not.toContain(PLAINTEXT_PRIVATE_KEY)
	})

	it("carries createdAt as the ISO string the wire actually sends, not a Date object", async () => {
		const { deps } = harness()
		const created = await createSshKeyController(deps).create(actor("owner"), {
			name: "deploy",
			type: "ed25519",
		})

		expect(created.createdAt).toBe("2026-08-30T00:00:00.000Z")
	})

	it("seals the generated private key and stores only the sealed form", async () => {
		const { deps, repos } = harness()
		await createSshKeyController(deps).create(actor("owner"), { name: "deploy", type: "ed25519" })

		expect(deps.secrets.seal).toHaveBeenCalledWith(PLAINTEXT_PRIVATE_KEY)
		expect(repos.sshKeys.insert).toHaveBeenCalledWith(
			{ organizationId: "org-1" },
			{
				name: "deploy",
				publicKey: "ssh-ed25519 AAAApublic",
				privateKeyEncrypted: SEALED_CIPHERTEXT,
				privateKeyKeyId: SEALBOX_KEY_ID,
			},
		)
	})

	it("records the insert and its audit row in one transaction", async () => {
		const held = harness()
		await createSshKeyController(held.deps).create(actor("owner"), {
			name: "deploy",
			type: "ed25519",
		})

		expect(held.transactions).toBe(1)
		expect(held.audited).toEqual([
			{
				actorId: "mem-1",
				actorLabel: "owner@example.com",
				action: "sshKey.create",
				subjectType: "sshKey",
				subjectId: "key-1",
				detail: { name: "deploy" },
			},
		])
	})

	it("refuses a role without sshKey.manage before generating or sealing anything", async () => {
		for (const role of ["viewer", "operator"] as const) {
			const { deps, repos } = harness()
			await expect(
				createSshKeyController(deps).create(actor(role), { name: "deploy", type: "ed25519" }),
			).rejects.toBeInstanceOf(ForbiddenError)
			expect(deps.generateKeyPair).not.toHaveBeenCalled()
			expect(deps.secrets.seal).not.toHaveBeenCalled()
			expect(repos.sshKeys.insert).not.toHaveBeenCalled()
		}
	})
})

describe("sshKeyController.list", () => {
	it("returns only the public projection, never the sealed private key material", async () => {
		const { deps } = harness()
		const listed = await createSshKeyController(deps).list(actor("owner"))

		expect(listed).toHaveLength(1)
		for (const item of listed) {
			expect(Object.keys(item).sort()).toEqual(["createdAt", "id", "name", "publicKey"])
		}
		const serialized = JSON.stringify(listed)
		expect(serialized).not.toContain(SEALED_CIPHERTEXT)
		expect(serialized).not.toContain(SEALBOX_KEY_ID)
	})

	it("scopes the query to the actor's organization", async () => {
		const { deps } = harness()
		await createSshKeyController(deps).list({ ...actor("owner"), organizationId: "org-2" })

		expect(deps.sshKeys.list).toHaveBeenCalledWith({ organizationId: "org-2" })
	})

	it("refuses a role without sshKey.manage before reading anything", async () => {
		const { deps } = harness()
		await expect(createSshKeyController(deps).list(actor("viewer"))).rejects.toBeInstanceOf(
			ForbiddenError,
		)
		expect(deps.sshKeys.list).not.toHaveBeenCalled()
	})
})

describe("sshKeyController.remove", () => {
	it("audits a deletion that removed a row", async () => {
		const held = harness()
		const removed = await createSshKeyController(held.deps).remove(actor("owner"), "key-1")

		expect(removed).toBe(true)
		expect(held.transactions).toBe(1)
		expect(held.audited).toEqual([
			{
				actorId: "mem-1",
				actorLabel: "owner@example.com",
				action: "sshKey.delete",
				subjectType: "sshKey",
				subjectId: "key-1",
				detail: {},
			},
		])
	})

	it("writes no audit row when the key belonged to another organization", async () => {
		const held = harness({ sshKeys: { insert: vi.fn(), delete: vi.fn(async () => false) } })
		const removed = await createSshKeyController(held.deps).remove(actor("owner"), "key-1")

		expect(removed).toBe(false)
		expect(held.audited).toEqual([])
	})

	it("refuses a role without sshKey.manage before deleting anything", async () => {
		const { deps, repos } = harness()
		await expect(
			createSshKeyController(deps).remove(actor("operator"), "key-1"),
		).rejects.toBeInstanceOf(ForbiddenError)
		expect(repos.sshKeys.delete).not.toHaveBeenCalled()
	})
})
