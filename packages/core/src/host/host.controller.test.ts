import { fingerprintFromKey } from "@open-mcc/contracts/boundary/ssh"
import type { AuditEventRow, HostRow, SshKeyRow } from "@open-mcc/db"
import { type ConnectionState, createFakeTransport, type HostTransport } from "@open-mcc/transport"
import { describe, expect, it, vi } from "vitest"
import type { AuditEntry, AuditRepository } from "../audit/audit.repository"
import type { SecretStore } from "../crypto/sealed-box"
import type { SshKeyRepository } from "../ssh-key/ssh-key.repository"
import {
	CONNECT_TIMEOUT_MS,
	createHostController,
	HostConcurrentlyModifiedError,
	type HostControllerDeps,
	HostProvisioningFailedError,
	HostProvisioningInProgressError,
	HostUnreachableError,
	type WithTransaction,
} from "./host.controller"
import type {
	HostCreateValues,
	HostKeyTrustUpdate,
	HostRepository,
	HostUpdateValues,
	OrgScope,
} from "./host.repository"
import { PROVISIONING_LEASE_MS } from "./host.repository"
import { provisionHost } from "./provision"

const CLIENT_PROBE_OK = {
	"'/srv/open-mcc/bin/MinecraftClient' --help < /dev/null 2>&1": {
		stdout: "Minecraft Console Client v26.2",
		stderr: "",
		exitCode: 0,
	},
}

const ctx = {
	organizationId: "org-1",
	memberId: "mem-1",
	actorLabel: "actor@example.com",
	role: "owner" as const,
}

const encodeAlgorithmBlob = (algorithm: string, extra: Buffer = Buffer.alloc(0)): Buffer => {
	const name = Buffer.from(algorithm, "ascii")
	const length = Buffer.alloc(4)
	length.writeUInt32BE(name.length, 0)
	return Buffer.concat([length, name, extra])
}

const DEFAULT_HOST_KEY_BLOB = encodeAlgorithmBlob("ssh-ed25519", Buffer.from("host-key-material"))

const makeHostRow = (overrides: Partial<HostRow> = {}): HostRow => ({
	id: "host-1",
	organizationId: "org-1",
	name: "vps",
	hostname: "10.0.0.1",
	port: 22,
	username: "mcc",
	mode: "system",
	instancesRoot: "/srv/open-mcc",
	unitDir: "/etc/systemd/system",
	sandboxed: true,
	osId: "debian",
	osName: "Debian GNU/Linux 12 (bookworm)",
	sshKeyId: "key-1",
	hostKeyAlgorithm: "ssh-ed25519",
	hostKeyFingerprint: null,
	hostKeyTrustedBy: null,
	hostKeyTrustedByLabel: "unknown",
	hostKeyTrustedAt: null,
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
	actorLabel: "actor@example.com",
	action: "host.enroll",
	subjectType: "host",
	subjectId: "host-1",
	detail: {},
	createdAt: new Date(),
	...overrides,
})

type RejectingTransportMode = "connect" | "exec"
type RejectingTransportOptions = { closeThrows?: boolean; closeError?: Error }

const createRejectingTransport = (
	mode: RejectingTransportMode,
	options: RejectingTransportOptions = {},
): HostTransport & { wasClosed: () => boolean } => {
	let state: ConnectionState = "disconnected"
	let closeAttempted = false

	return {
		state: () => state,
		connect: async () => {
			if (mode === "connect") {
				state = "failed"
				throw new Error("Connection refused")
			}
			state = "ready"
		},
		exec: async () => {
			if (mode === "exec") throw new Error("Connection reset by peer")
			return { stdout: "", stderr: "", exitCode: 0 }
		},
		close: async () => {
			closeAttempted = true
			if (options.closeError) throw options.closeError
			if (options.closeThrows) throw new Error("close failed")
			state = "disconnected"
		},
		wasClosed: () => closeAttempted,
	}
}

const deps = (
	overrides: Partial<HostControllerDeps> = {},
): HostControllerDeps & { audit: Pick<AuditRepository, "record"> } => {
	const hosts: HostRepository = {
		insert: vi.fn(async (_scope: OrgScope, _values: HostCreateValues) => makeHostRow()),
		findById: vi.fn(async () => makeHostRow({ hostKeyFingerprint: "SHA256:trusted" })),
		list: vi.fn(async () => []),
		update: vi.fn(async (_scope: OrgScope, id: string, patch: HostUpdateValues) =>
			makeHostRow({
				id,
				status: patch.status ?? "pending",
				osRelease: patch.osRelease ?? null,
			}),
		),
		delete: vi.fn(async () => true),
		recordProvisioningProgress: vi.fn(async () => undefined),
		recordProvisioningFailure: vi.fn(async () => undefined),
		lockHost: vi.fn(async () => undefined),
		claimForProvisioning: vi.fn(async (_scope: OrgScope, id: string) =>
			makeHostRow({
				id,
				status: "provisioning",
				hostKeyFingerprint: "SHA256:trusted",
				provisioningAttemptId: "attempt-1",
				provisioningClaimedAt: new Date(),
			}),
		),
		finalizeProvisioning: vi.fn(
			async (
				_scope: OrgScope,
				id: string,
				_attemptId: string,
				patch: Pick<HostUpdateValues, "status" | "osRelease">,
			) =>
				makeHostRow({
					id,
					status: patch.status ?? "pending",
					osRelease: patch.osRelease ?? null,
				}),
		),
		updateHostKeyTrust: vi.fn(async (_scope: OrgScope, id: string, trust: HostKeyTrustUpdate) =>
			makeHostRow({ id, ...trust }),
		),
	}
	const audit: Pick<AuditRepository, "record"> = {
		record: vi.fn(async (_scope: OrgScope, entry: AuditEntry) => makeAuditEventRow({ ...entry })),
	}
	const withTransaction: WithTransaction = async (fn) => fn({ hosts, audit })

	return {
		hosts,
		sshKeys: {
			findById: vi.fn(async () => makeSshKeyRow()),
		} satisfies Pick<SshKeyRepository, "findById">,
		audit,
		secrets: {
			open: vi.fn(() => "PRIVATE KEY"),
			activeKeyId: "k1",
			seal: vi.fn(),
		} satisfies SecretStore,
		probeHostKey: vi.fn(async () => DEFAULT_HOST_KEY_BLOB),
		createTransport: vi.fn(() =>
			createFakeTransport({
				...CLIENT_PROBE_OK,
				"systemctl --version | head -n 1": { stdout: "systemd 252", stderr: "", exitCode: 0 },
			}),
		),
		withTransaction,
		...overrides,
	}
}

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
					mode: "system",
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
				mode: "system",
				sshKeyId: "key-1",
				expectedFingerprint: "SHA256:wrong",
			}),
		).rejects.toThrow(/fingerprint mismatch/i)
		expect(d.hosts.insert).not.toHaveBeenCalled()
		expect(d.audit.record).not.toHaveBeenCalled()
	})

	it("never hands the presented fingerprint back in the mismatch error", async () => {
		const d = deps()
		const controller = createHostController(d)
		const realFingerprint = fingerprintFromKey(DEFAULT_HOST_KEY_BLOB)

		try {
			await controller.enroll(ctx, {
				name: "vps",
				hostname: "10.0.0.1",
				port: 22,
				username: "mcc",
				mode: "system",
				sshKeyId: "key-1",
				expectedFingerprint: "SHA256:wrong",
			})
			throw new Error("expected enroll to reject")
		} catch (error) {
			expect(error).toBeInstanceOf(Error)
			const message = error instanceof Error ? error.message : ""
			expect(message).not.toContain(realFingerprint)
			expect(message).not.toContain(realFingerprint.slice("SHA256:".length, "SHA256:".length + 12))
		}
	})

	it("enrolls and audits when the fingerprint matches", async () => {
		const d = deps()
		const expected = fingerprintFromKey(DEFAULT_HOST_KEY_BLOB)
		const controller = createHostController(d)
		const created = await controller.enroll(ctx, {
			name: "vps",
			hostname: "10.0.0.1",
			port: 22,
			username: "mcc",
			mode: "system",
			sshKeyId: "key-1",
			expectedFingerprint: expected,
		})
		expect(created.id).toBe("host-1")
		expect(d.hosts.insert).toHaveBeenCalledWith(
			{ organizationId: "org-1" },
			expect.objectContaining({
				hostKeyAlgorithm: "ssh-ed25519",
				hostKeyFingerprint: expected,
				hostKeyTrustedBy: "mem-1",
				hostKeyTrustedByLabel: "actor@example.com",
				hostKeyTrustedAt: expect.any(Date),
			}),
		)
		expect(d.audit.record).toHaveBeenCalledTimes(1)
		expect(d.audit.record).toHaveBeenCalledWith(
			{ organizationId: "org-1" },
			expect.objectContaining({
				action: "host.enroll",
				actorId: "mem-1",
				actorLabel: "actor@example.com",
				detail: expect.objectContaining({ fingerprint: expected }),
			}),
		)
	})

	it("stores the algorithm parsed from the presented key, not a hardcoded constant", async () => {
		const blob = encodeAlgorithmBlob("ssh-rsa", Buffer.from("rsa-host-key-material"))
		const expected = fingerprintFromKey(blob)
		const d = deps({ probeHostKey: vi.fn(async () => blob) })
		const controller = createHostController(d)

		await controller.enroll(ctx, {
			name: "vps",
			hostname: "10.0.0.1",
			port: 22,
			username: "mcc",
			mode: "system",
			sshKeyId: "key-1",
			expectedFingerprint: expected,
		})

		expect(d.hosts.insert).toHaveBeenCalledWith(
			{ organizationId: "org-1" },
			expect.objectContaining({ hostKeyAlgorithm: "ssh-rsa" }),
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
		expect(d.hosts.finalizeProvisioning).not.toHaveBeenCalled()
	})

	it("rejects provisioning a host that is already provisioning, without touching secrets or transport", async () => {
		const d = deps({
			hosts: {
				insert: vi.fn(async () => makeHostRow()),
				findById: vi.fn(async () =>
					makeHostRow({
						hostKeyFingerprint: "SHA256:trusted",
						status: "provisioning",
						provisioningAttemptId: "attempt-live",
						provisioningClaimedAt: new Date(),
					}),
				),
				list: vi.fn(async () => []),
				update: vi.fn(async () => makeHostRow()),
				delete: vi.fn(async () => true),
				recordProvisioningProgress: vi.fn(async () => undefined),
				recordProvisioningFailure: vi.fn(async () => undefined),
				lockHost: vi.fn(async () => undefined),
				claimForProvisioning: vi.fn(async () => makeHostRow({ status: "provisioning" })),
				finalizeProvisioning: vi.fn(async () => makeHostRow()),
				updateHostKeyTrust: vi.fn(async () => makeHostRow()),
			},
		})
		const controller = createHostController(d)

		const attempt = controller.provision(ctx, "host-1")
		await expect(attempt).rejects.toThrow(HostProvisioningInProgressError)
		await expect(attempt).rejects.not.toThrow(HostConcurrentlyModifiedError)

		expect(d.hosts.lockHost).not.toHaveBeenCalled()
		expect(d.hosts.claimForProvisioning).not.toHaveBeenCalled()
		expect(d.secrets.open).not.toHaveBeenCalled()
		expect(d.createTransport).not.toHaveBeenCalled()
	})

	it("treats a provisioning host with null lease metadata as reclaimable, defending a state host_provisioning_requires_lease forbids today", async () => {
		const hosts: HostRepository = {
			insert: vi.fn(async () => makeHostRow()),
			findById: vi.fn(async () =>
				makeHostRow({
					hostKeyFingerprint: "SHA256:trusted",
					status: "provisioning",
					provisioningAttemptId: null,
					provisioningClaimedAt: null,
				}),
			),
			list: vi.fn(async () => []),
			update: vi.fn(async () => makeHostRow()),
			delete: vi.fn(async () => true),
			recordProvisioningProgress: vi.fn(async () => undefined),
			recordProvisioningFailure: vi.fn(async () => undefined),
			lockHost: vi.fn(async () => undefined),
			claimForProvisioning: vi.fn(async () =>
				makeHostRow({
					status: "provisioning",
					hostKeyFingerprint: "SHA256:trusted",
					provisioningAttemptId: "attempt-1",
					provisioningClaimedAt: new Date(),
				}),
			),
			finalizeProvisioning: vi.fn(
				async (
					_scope: OrgScope,
					id: string,
					_attemptId: string,
					patch: Pick<HostUpdateValues, "status" | "osRelease">,
				) =>
					makeHostRow({
						id,
						status: patch.status ?? "pending",
						osRelease: patch.osRelease ?? null,
					}),
			),
			updateHostKeyTrust: vi.fn(async () => makeHostRow()),
		}
		const auditRecord = vi.fn(async (_scope: OrgScope, entry: AuditEntry) =>
			makeAuditEventRow({ ...entry }),
		)
		const withTransaction: WithTransaction = async (fn) =>
			fn({ hosts, audit: { record: auditRecord } })
		const d = deps({ hosts, withTransaction })
		const controller = createHostController(d)

		const result = await controller.provision(ctx, "host-1")

		expect(result?.status).toBe("ready")
		expect(hosts.claimForProvisioning).toHaveBeenCalled()
		expect(auditRecord).toHaveBeenCalledWith(
			{ organizationId: "org-1" },
			expect.objectContaining({ action: "host.provision.reclaim" }),
		)
	})

	it("aborts before decrypting the key or contacting the host when the claim races and loses", async () => {
		const claimForProvisioning = vi.fn(async () => undefined)
		const withTransaction: WithTransaction = async (fn) =>
			fn({
				hosts: {
					insert: vi.fn(async () => makeHostRow()),
					findById: vi.fn(async () => makeHostRow({ hostKeyFingerprint: "SHA256:trusted" })),
					list: vi.fn(async () => []),
					update: vi.fn(async () => makeHostRow()),
					delete: vi.fn(async () => true),
					recordProvisioningProgress: vi.fn(async () => undefined),
					recordProvisioningFailure: vi.fn(async () => undefined),
					lockHost: vi.fn(async () => undefined),
					claimForProvisioning,
					finalizeProvisioning: vi.fn(async () => makeHostRow()),
					updateHostKeyTrust: vi.fn(async () => makeHostRow()),
				},
				audit: {
					record: vi.fn(async (_scope: OrgScope, entry: AuditEntry) =>
						makeAuditEventRow({ ...entry }),
					),
				},
			})
		const d = deps({ withTransaction })
		const controller = createHostController(d)

		await expect(controller.provision(ctx, "host-1")).rejects.toThrow(/changed/i)

		expect(claimForProvisioning).toHaveBeenCalledWith(
			{ organizationId: "org-1" },
			"host-1",
			"pending",
		)
		expect(d.secrets.open).not.toHaveBeenCalled()
		expect(d.createTransport).not.toHaveBeenCalled()
	})

	it("aborts and skips the audit write when the final transition affects no row", async () => {
		const finalizeProvisioning = vi.fn(async () => undefined)
		const auditRecord = vi.fn(async (_scope: OrgScope, entry: AuditEntry) =>
			makeAuditEventRow({ ...entry }),
		)
		const withTransaction: WithTransaction = async (fn) =>
			fn({
				hosts: {
					insert: vi.fn(async () => makeHostRow()),
					findById: vi.fn(async () => makeHostRow({ hostKeyFingerprint: "SHA256:trusted" })),
					list: vi.fn(async () => []),
					update: vi.fn(async () => makeHostRow()),
					delete: vi.fn(async () => false),
					recordProvisioningProgress: vi.fn(async () => undefined),
					recordProvisioningFailure: vi.fn(async () => undefined),
					lockHost: vi.fn(async () => undefined),
					claimForProvisioning: vi.fn(async () =>
						makeHostRow({
							status: "provisioning",
							hostKeyFingerprint: "SHA256:trusted",
							provisioningAttemptId: "attempt-1",
							provisioningClaimedAt: new Date(),
						}),
					),
					finalizeProvisioning,
					updateHostKeyTrust: vi.fn(async () => makeHostRow()),
				},
				audit: { record: auditRecord },
			})
		const d = deps({ withTransaction })
		const controller = createHostController(d)

		await expect(controller.provision(ctx, "host-1")).rejects.toThrow(/changed/i)

		expect(finalizeProvisioning).toHaveBeenCalledWith(
			{ organizationId: "org-1" },
			"host-1",
			"attempt-1",
			expect.objectContaining({ status: "ready" }),
		)
		expect(auditRecord).not.toHaveBeenCalled()
	})

	it("locks the host, claims it conditionally on its current status, and transitions to ready once it succeeds", async () => {
		const transport = createFakeTransport({
			...CLIENT_PROBE_OK,
			['. /etc/os-release 2>/dev/null; printf \'%s\\n%s\' "${ID:-}" "${PRETTY_NAME:-}"']: {
				stdout: "debian\nDebian GNU/Linux 12 (bookworm)",
				stderr: "",
				exitCode: 0,
			},
			"systemctl --version | head -n 1": { stdout: "systemd 252", stderr: "", exitCode: 0 },
		})
		const d = deps({ createTransport: vi.fn(() => transport) })
		const controller = createHostController(d)

		const updated = await controller.provision(ctx, "host-1")

		expect(d.secrets.open).toHaveBeenCalledWith("sealed", "k1")
		expect(transport.commands).toContain("systemctl --version | head -n 1")
		expect(transport.commands).toContain(
			"install -d -m 0711 -o root -g root '/srv/open-mcc/instances'",
		)
		expect(transport.state()).toBe("disconnected")
		expect(updated?.osRelease).toBe("systemd 252")
		expect(d.hosts.lockHost).toHaveBeenCalledWith({ organizationId: "org-1" }, "host-1")
		expect(d.hosts.claimForProvisioning).toHaveBeenCalledWith(
			{ organizationId: "org-1" },
			"host-1",
			"pending",
		)
		expect(d.hosts.finalizeProvisioning).toHaveBeenCalledTimes(1)
		expect(d.hosts.finalizeProvisioning).toHaveBeenCalledWith(
			{ organizationId: "org-1" },
			"host-1",
			"attempt-1",
			{
				status: "ready",
				osRelease: "systemd 252",
				instancesRoot: "/srv/open-mcc",
				unitDir: "/etc/systemd/system",
				sandboxed: true,
				osId: "debian",
				osName: "Debian GNU/Linux 12 (bookworm)",
			},
		)
		expect(d.audit.record).toHaveBeenCalledTimes(1)
		expect(d.audit.record).toHaveBeenCalledWith(
			{ organizationId: "org-1" },
			expect.objectContaining({
				action: "host.provision",
				actorId: "mem-1",
				actorLabel: "actor@example.com",
			}),
		)
	})

	it("transitions status to error and rethrows the original error when systemd is missing, without auditing or leaking the private key", async () => {
		const transport = createFakeTransport({
			...CLIENT_PROBE_OK,
			"systemctl --version | head -n 1": { stdout: "", stderr: "not found", exitCode: 127 },
		})
		const d = deps({ createTransport: vi.fn(() => transport) })
		const controller = createHostController(d)

		try {
			await controller.provision(ctx, "host-1")
			throw new Error("expected provision to reject")
		} catch (error) {
			expect(error).toBeInstanceOf(Error)
			const message = error instanceof Error ? error.message : ""
			expect(message).toMatch(/systemd/i)
			expect(message).not.toContain("PRIVATE KEY")
		}

		expect(transport.state()).toBe("disconnected")
		expect(d.hosts.claimForProvisioning).toHaveBeenCalledTimes(1)
		expect(d.hosts.finalizeProvisioning).toHaveBeenCalledTimes(1)
		expect(d.hosts.finalizeProvisioning).toHaveBeenCalledWith(
			{ organizationId: "org-1" },
			"host-1",
			"attempt-1",
			{ status: "error" },
		)
		expect(d.audit.record).not.toHaveBeenCalled()
	})

	it("propagates a connect() rejection, marks the host errored, and writes no audit entry", async () => {
		const transport = createRejectingTransport("connect")
		const d = deps({ createTransport: vi.fn(() => transport) })
		const controller = createHostController(d)

		await expect(controller.provision(ctx, "host-1")).rejects.toThrow(/connection refused/i)

		expect(transport.wasClosed()).toBe(true)
		expect(d.hosts.finalizeProvisioning).toHaveBeenCalledWith(
			{ organizationId: "org-1" },
			"host-1",
			"attempt-1",
			{ status: "error" },
		)
		expect(d.audit.record).not.toHaveBeenCalled()
	})

	it("propagates an exec() rejection, marks the host errored, and writes no audit entry", async () => {
		const transport = createRejectingTransport("exec")
		const d = deps({ createTransport: vi.fn(() => transport) })
		const controller = createHostController(d)

		await expect(controller.provision(ctx, "host-1")).rejects.toThrow(/connection reset/i)

		expect(transport.wasClosed()).toBe(true)
		expect(d.hosts.finalizeProvisioning).toHaveBeenCalledWith(
			{ organizationId: "org-1" },
			"host-1",
			"attempt-1",
			{ status: "error" },
		)
		expect(d.audit.record).not.toHaveBeenCalled()
	})

	it("redacts private key material out of a close() failure before it reaches the log", async () => {
		const privateKey =
			"-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEotSECRET\n-----END OPENSSH PRIVATE KEY-----"
		const transport = createRejectingTransport("exec", {
			closeError: new Error(`Cannot parse privateKey: ${privateKey}`),
		})
		const d = deps({ createTransport: vi.fn(() => transport) })
		const controller = createHostController(d)
		const logged = vi.spyOn(console, "error").mockImplementation(() => {})

		try {
			await expect(controller.provision(ctx, "host-1")).rejects.toThrow(/connection reset/i)
			const closeLog = logged.mock.calls.find((call) => String(call[0]).includes("close transport"))
			expect(closeLog).toBeDefined()
			const loggedText = closeLog?.slice(1).join(" ") ?? ""
			expect(loggedText).not.toContain("otSECRET")
			expect(loggedText).toContain("[redacted private key]")
		} finally {
			logged.mockRestore()
		}
	})

	it("does not let a close() failure mask the original provisioning error", async () => {
		const transport = createRejectingTransport("exec", { closeThrows: true })
		const d = deps({ createTransport: vi.fn(() => transport) })
		const controller = createHostController(d)

		await expect(controller.provision(ctx, "host-1")).rejects.toThrow(/connection reset/i)

		expect(transport.wasClosed()).toBe(true)
		expect(d.hosts.finalizeProvisioning).toHaveBeenCalledWith(
			{ organizationId: "org-1" },
			"host-1",
			"attempt-1",
			{ status: "error" },
		)
		expect(d.audit.record).not.toHaveBeenCalled()
	})
})

describe("host controller removal", () => {
	it("removes a provisioning host with null lease metadata, defending a state host_provisioning_requires_lease forbids today", async () => {
		const hosts: HostRepository = {
			insert: vi.fn(async () => makeHostRow()),
			findById: vi.fn(async () =>
				makeHostRow({
					status: "provisioning",
					provisioningAttemptId: null,
					provisioningClaimedAt: null,
				}),
			),
			list: vi.fn(async () => []),
			update: vi.fn(async () => makeHostRow()),
			delete: vi.fn(async () => true),
			recordProvisioningProgress: vi.fn(async () => undefined),
			recordProvisioningFailure: vi.fn(async () => undefined),
			lockHost: vi.fn(async () => undefined),
			claimForProvisioning: vi.fn(async () => makeHostRow({ status: "provisioning" })),
			finalizeProvisioning: vi.fn(async () => makeHostRow()),
			updateHostKeyTrust: vi.fn(async () => makeHostRow()),
		}
		const auditRecord = vi.fn(async (_scope: OrgScope, entry: AuditEntry) =>
			makeAuditEventRow({ ...entry }),
		)
		const withTransaction: WithTransaction = async (fn) =>
			fn({ hosts, audit: { record: auditRecord } })
		const d = deps({ hosts, withTransaction })
		const controller = createHostController(d)

		await expect(controller.remove(ctx, "host-1")).resolves.toBe(true)
		expect(hosts.delete).toHaveBeenCalled()
	})
})

const provisionConnectOptions = {
	hostname: "10.0.0.1",
	port: 22,
	username: "mcc",
	privateKey: "PRIVATE KEY",
	expectedFingerprint: "SHA256:trusted",
	timeoutMs: 1000,
}

describe("provisionHost", () => {
	it("records the systemd version and creates a setgid instances directory", async () => {
		const transport = createFakeTransport({
			...CLIENT_PROBE_OK,
			"systemctl --version | head -n 1": {
				stdout: "systemd 252 (252.22-1~deb12u1)",
				stderr: "",
				exitCode: 0,
			},
		})
		await transport.connect(provisionConnectOptions)
		const result = await provisionHost(transport, { mode: "system" })
		expect(result.osRelease).toBe("systemd 252 (252.22-1~deb12u1)")
		expect(transport.commands).toContain(
			"install -d -m 0711 -o root -g root '/srv/open-mcc/instances'",
		)
	})

	it("fails when systemd is absent", async () => {
		const transport = createFakeTransport({
			...CLIENT_PROBE_OK,
			"systemctl --version | head -n 1": { stdout: "", stderr: "not found", exitCode: 127 },
		})
		await transport.connect(provisionConnectOptions)
		await expect(provisionHost(transport, { mode: "system" })).rejects.toThrow(/systemd/i)
	})

	it("propagates when exec() rejects mid-command rather than resolving as if disconnected", async () => {
		const transport = createRejectingTransport("exec")
		await expect(provisionHost(transport, { mode: "system" })).rejects.toThrow(/connection reset/i)
	})

	it("refuses a home directory carrying a shell metacharacter, so a hostile host cannot smuggle a command into every later path", async () => {
		const transport = createFakeTransport({
			...CLIENT_PROBE_OK,
			"systemctl --version | head -n 1": { stdout: "systemd 252", stderr: "", exitCode: 0 },
			'printf %s "$HOME"': { stdout: "/home/$(id -u)", stderr: "", exitCode: 0 },
		})
		await transport.connect(provisionConnectOptions)

		await expect(provisionHost(transport, { mode: "rootless" })).rejects.toThrow(/absolute path/i)
		expect(transport.commands.some((command) => command.includes("curl"))).toBe(false)
		expect(transport.commands.some((command) => command.includes("install -d"))).toBe(false)
	})

	it("refuses a relative home directory rather than resolving it against an unknown working directory", async () => {
		const transport = createFakeTransport({
			...CLIENT_PROBE_OK,
			"systemctl --version | head -n 1": { stdout: "systemd 252", stderr: "", exitCode: 0 },
			'printf %s "$HOME"': { stdout: "home/mccuser", stderr: "", exitCode: 0 },
		})
		await transport.connect(provisionConnectOptions)

		await expect(provisionHost(transport, { mode: "rootless" })).rejects.toThrow(/absolute path/i)
		expect(transport.commands.some((command) => command.includes("curl"))).toBe(false)
	})

	it("finishes its worst-case remote work inside the provisioning lease, counting every step it actually runs", async () => {
		const transport = createFakeTransport(CLIENT_PROBE_OK)
		await transport.connect(provisionConnectOptions)
		await provisionHost(transport, { mode: "system" })

		const remoteBudgetMs = transport.timeouts.reduce((total, each) => total + each, 0)
		const worstCaseMs = CONNECT_TIMEOUT_MS + remoteBudgetMs
		expect(transport.timeouts).toHaveLength(transport.commands.length)
		expect(worstCaseMs).toBeLessThan(PROVISIONING_LEASE_MS)
	})
})

describe("what provisioning tells the operator when it fails", () => {
	const provisioningHosts = (transport: HostTransport) => {
		const hosts = {
			findById: vi.fn(async () =>
				makeHostRow({
					status: "pending",
					sshKeyId: "key-1",
					hostKeyFingerprint: "SHA256:trusted",
					provisioningAttemptId: null,
					provisioningClaimedAt: null,
				}),
			),
			insert: vi.fn(async () => makeHostRow()),
			list: vi.fn(async () => []),
			update: vi.fn(async () => makeHostRow()),
			delete: vi.fn(async () => true),
			recordProvisioningProgress: vi.fn(async () => undefined),
			recordProvisioningFailure: vi.fn(async () => undefined),
			lockHost: vi.fn(async () => undefined),
			claimForProvisioning: vi.fn(async () =>
				makeHostRow({
					status: "provisioning",
					hostKeyFingerprint: "SHA256:trusted",
					provisioningAttemptId: "attempt-1",
					provisioningClaimedAt: new Date(),
				}),
			),
			finalizeProvisioning: vi.fn(async () => makeHostRow()),
			updateHostKeyTrust: vi.fn(async () => makeHostRow()),
		}
		const withTransaction: WithTransaction = async (fn) =>
			fn({ hosts, audit: { record: vi.fn(async () => makeAuditEventRow({})) } })
		return {
			hosts,
			controller: createHostController(
				deps({ hosts, withTransaction, createTransport: () => transport }),
			),
		}
	}

	it("reports a host it could not connect to as unreachable, not as an internal fault", async () => {
		const { controller } = provisioningHosts(createRejectingTransport("connect"))

		await expect(controller.provision(ctx, "host-1")).rejects.toBeInstanceOf(HostUnreachableError)
	})

	it("reports a step that failed on the host as a provisioning failure, not as an internal fault", async () => {
		const transport = createFakeTransport({
			"systemctl --version | head -n 1": { stdout: "", stderr: "not found", exitCode: 127 },
		})
		const { controller } = provisioningHosts(transport)

		await expect(controller.provision(ctx, "host-1")).rejects.toBeInstanceOf(
			HostProvisioningFailedError,
		)
	})

	it("still records why it failed, so the host page can show the reason", async () => {
		const { controller, hosts } = provisioningHosts(createRejectingTransport("connect"))

		await expect(controller.provision(ctx, "host-1")).rejects.toThrow()
		expect(hosts.recordProvisioningFailure).toHaveBeenCalledWith(
			expect.anything(),
			"host-1",
			"attempt-1",
			expect.stringMatching(/.+/),
		)
	})
})
