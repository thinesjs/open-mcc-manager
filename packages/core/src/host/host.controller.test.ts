import type { AuditEventRow, HostRow, SshKeyRow } from "@open-mcc/db"
import { createFakeTransport } from "@open-mcc/transport"
import { describe, expect, it, vi } from "vitest"
import type { AuditEntry, AuditRepository } from "../audit/audit.repository"
import type { SecretStore } from "../crypto/sealed-box"
import type { SshKeyRepository } from "../ssh-key/ssh-key.repository"
import { createHostController, type HostControllerDeps } from "./host.controller"
import type { HostCreateValues, HostRepository, OrgScope } from "./host.repository"
import { provisionHost } from "./provision"

const ctx = { organizationId: "org-1", memberId: "mem-1", role: "owner" as const }

const makeHostRow = (overrides: Partial<HostRow> = {}): HostRow => ({
	id: "host-1",
	organizationId: "org-1",
	name: "vps",
	hostname: "10.0.0.1",
	port: 22,
	username: "mcc",
	sshKeyId: "key-1",
	hostKeyAlgorithm: "ssh-ed25519",
	hostKeyFingerprint: null,
	hostKeyTrustedBy: null,
	hostKeyTrustedAt: null,
	status: "pending",
	dockerVersion: null,
	osRelease: null,
	cpuCount: null,
	memoryMb: null,
	capacityLimit: null,
	lastSeenAt: null,
	createdAt: new Date(),
	...overrides,
})

const makeSshKeyRow = (overrides: Partial<SshKeyRow> = {}): SshKeyRow => ({
	id: "key-1",
	organizationId: "org-1",
	name: "key-1",
	publicKey: "ssh-ed25519 AAAA...",
	privateKeyEncrypted: "sealed",
	privateKeyKeyId: "k1",
	createdAt: new Date(),
	...overrides,
})

const makeAuditEventRow = (overrides: Partial<AuditEventRow> = {}): AuditEventRow => ({
	id: "audit-1",
	organizationId: "org-1",
	actorId: "mem-1",
	action: "host.enroll",
	subjectType: "host",
	subjectId: "host-1",
	detail: {},
	createdAt: new Date(),
	...overrides,
})

const deps = (overrides: Partial<HostControllerDeps> = {}): HostControllerDeps => ({
	hosts: {
		insert: vi.fn(async (_scope: OrgScope, _values: HostCreateValues) => makeHostRow()),
		findById: vi.fn(async () => makeHostRow({ hostKeyFingerprint: "SHA256:trusted" })),
		list: vi.fn(async () => []),
		update: vi.fn(
			async (
				_scope: OrgScope,
				id: string,
				patch: Partial<HostCreateValues> & Partial<Pick<HostRow, "status">>,
			) =>
				makeHostRow({
					id,
					status: patch.status ?? "pending",
					dockerVersion: patch.dockerVersion ?? null,
				}),
		),
		delete: vi.fn(async () => true),
	} satisfies HostRepository,
	sshKeys: {
		findById: vi.fn(async () => makeSshKeyRow()),
	} satisfies Pick<SshKeyRepository, "findById">,
	audit: {
		record: vi.fn(async (_scope: OrgScope, entry: AuditEntry) => makeAuditEventRow({ ...entry })),
	} satisfies Pick<AuditRepository, "record">,
	secrets: {
		open: vi.fn(() => "PRIVATE KEY"),
		activeKeyId: "k1",
		seal: vi.fn(),
	} satisfies SecretStore,
	probeHostKey: vi.fn(async () => Buffer.from("host-key-material")),
	createTransport: vi.fn(() =>
		createFakeTransport({
			"docker --version": { stdout: "Docker version 27.3.1", stderr: "", exitCode: 0 },
		}),
	),
	instancesRoot: "/var/lib/open-mcc-manager",
	...overrides,
})

describe("host controller enrollment", () => {
	it("rejects a role without host.enroll", async () => {
		const d = deps()
		const controller = createHostController(d)
		await expect(
			controller.enroll(
				{ ...ctx, role: "operator" },
				{
					name: "vps",
					hostname: "10.0.0.1",
					port: 22,
					username: "mcc",
					sshKeyId: "key-1",
					expectedFingerprint: "SHA256:x",
				},
			),
		).rejects.toThrow(/forbidden/i)
		expect(d.hosts.insert).not.toHaveBeenCalled()
		expect(d.probeHostKey).not.toHaveBeenCalled()
	})

	it("refuses enrollment when the fingerprint does not match", async () => {
		const d = deps()
		const controller = createHostController(d)
		await expect(
			controller.enroll(ctx, {
				name: "vps",
				hostname: "10.0.0.1",
				port: 22,
				username: "mcc",
				sshKeyId: "key-1",
				expectedFingerprint: "SHA256:wrong",
			}),
		).rejects.toThrow(/fingerprint mismatch/i)
		expect(d.hosts.insert).not.toHaveBeenCalled()
		expect(d.audit.record).not.toHaveBeenCalled()
	})

	it("enrolls and audits when the fingerprint matches", async () => {
		const d = deps()
		const { fingerprintFromKey } = await import("@open-mcc/contracts/boundary/ssh")
		const expected = fingerprintFromKey(Buffer.from("host-key-material"))
		const controller = createHostController(d)
		const created = await controller.enroll(ctx, {
			name: "vps",
			hostname: "10.0.0.1",
			port: 22,
			username: "mcc",
			sshKeyId: "key-1",
			expectedFingerprint: expected,
		})
		expect(created.id).toBe("host-1")
		expect(d.audit.record).toHaveBeenCalledTimes(1)
		expect(d.audit.record).toHaveBeenCalledWith(
			{ organizationId: "org-1" },
			expect.objectContaining({
				action: "host.enroll",
				actorId: "mem-1",
				detail: expect.objectContaining({ fingerprint: expected }),
			}),
		)
	})
})

describe("host controller provisioning", () => {
	it("rejects a role without host.enroll", async () => {
		const d = deps()
		const controller = createHostController(d)
		await expect(controller.provision({ ...ctx, role: "operator" }, "host-1")).rejects.toThrow(
			/forbidden/i,
		)
		expect(d.hosts.findById).not.toHaveBeenCalled()
		expect(d.secrets.open).not.toHaveBeenCalled()
		expect(d.createTransport).not.toHaveBeenCalled()
	})

	it("decrypts the host's ssh key, provisions it, and audits the result", async () => {
		const transport = createFakeTransport({
			"docker --version": { stdout: "Docker version 27.3.1", stderr: "", exitCode: 0 },
		})
		const d = deps({ createTransport: vi.fn(() => transport) })
		const controller = createHostController(d)

		const updated = await controller.provision(ctx, "host-1")

		expect(d.secrets.open).toHaveBeenCalledWith("sealed", "k1")
		expect(transport.commands).toContain("docker --version")
		expect(transport.commands).toContain("install -d -m 0770 /var/lib/open-mcc-manager/instances")
		expect(transport.state()).toBe("disconnected")
		expect(updated?.dockerVersion).toBe("Docker version 27.3.1")
		expect(d.audit.record).toHaveBeenCalledTimes(1)
		expect(d.audit.record).toHaveBeenCalledWith(
			{ organizationId: "org-1" },
			expect.objectContaining({ action: "host.provision", actorId: "mem-1" }),
		)
	})

	it("fails without persisting or auditing when docker is missing, and never leaks the private key", async () => {
		const transport = createFakeTransport({
			"docker --version": { stdout: "", stderr: "not found", exitCode: 127 },
		})
		const d = deps({ createTransport: vi.fn(() => transport) })
		const controller = createHostController(d)

		try {
			await controller.provision(ctx, "host-1")
			throw new Error("expected provision to reject")
		} catch (error) {
			expect(error).toBeInstanceOf(Error)
			const message = error instanceof Error ? error.message : ""
			expect(message).toMatch(/docker/i)
			expect(message).not.toContain("PRIVATE KEY")
		}

		expect(transport.state()).toBe("disconnected")
		expect(d.hosts.update).not.toHaveBeenCalled()
		expect(d.audit.record).not.toHaveBeenCalled()
	})
})

describe("provisionHost", () => {
	it("installs docker and creates the instances directory", async () => {
		const transport = createFakeTransport({
			"docker --version": { stdout: "Docker version 27.3.1", stderr: "", exitCode: 0 },
		})
		const result = await provisionHost(transport, { instancesRoot: "/var/lib/open-mcc-manager" })
		expect(result.dockerVersion).toBe("Docker version 27.3.1")
		expect(transport.commands).toContain("install -d -m 0770 /var/lib/open-mcc-manager/instances")
	})

	it("fails when docker is absent", async () => {
		const transport = createFakeTransport({
			"docker --version": { stdout: "", stderr: "not found", exitCode: 127 },
		})
		await expect(
			provisionHost(transport, { instancesRoot: "/var/lib/open-mcc-manager" }),
		).rejects.toThrow(/docker/i)
	})
})
