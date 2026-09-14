import { fingerprintFromKey } from "@open-mcc/contracts/boundary/ssh"
import type { AuditEventRow, HostRow, SshKeyRow } from "@open-mcc/db"
import { type ConnectionState, createFakeTransport, type HostTransport } from "@open-mcc/transport"
import { describe, expect, it, vi } from "vitest"
import type { AuditEntry, AuditRepository } from "../audit/audit.repository"
import type { SecretStore } from "../crypto/sealed-box"
import type { SshKeyRepository } from "../ssh-key/ssh-key.repository"
import { LINGER_COMMAND } from "./check"
import {
	CONNECT_TIMEOUT_MS,
	createHostController,
	FingerprintMismatchError,
	HostConcurrentlyModifiedError,
	type HostControllerDeps,
	HostHasInstancesError,
	HostNotFoundError,
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
import { HOME_COMMAND, provisionHost } from "./provision"

const jobsDouble = () => ({ enqueue: vi.fn(async () => undefined) })

const PROVISIONABLE = {
	[HOME_COMMAND]: { stdout: "/home/mcc\n/home/mcc", stderr: "", exitCode: 0 },
	[LINGER_COMMAND]: { stdout: "yes", stderr: "", exitCode: 0 },
	'"$HOME"/.local/share/open-mcc/bin/MinecraftClient --help < /dev/null 2>&1': {
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
	networkStack: null,
	osId: "debian",
	osName: "Debian GNU/Linux 12 (bookworm)",
	failedUnits: null,
	teardownError: null,
	teardownRequestedAt: null,
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
		canForward: async () => true,
		forward: () => Promise.reject(new Error("not forwarded in this test")),
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
		beginTeardown: vi.fn(async () => true),
		recordTeardownFailure: vi.fn(async () => undefined),
		deleteAfterTeardown: vi.fn(async () => true),
		listPollableAcrossOrganizations: vi.fn(async () => []),
		recordSeen: vi.fn(async () => undefined),
		updateHostKeyTrust: vi.fn(async (_scope: OrgScope, id: string, trust: HostKeyTrustUpdate) =>
			makeHostRow({ id, ...trust }),
		),
	}
	const audit: Pick<AuditRepository, "record"> = {
		record: vi.fn(async (_scope: OrgScope, entry: AuditEntry) => makeAuditEventRow({ ...entry })),
	}
	const withTransaction: WithTransaction = async (fn) => fn({ hosts, audit, jobs: jobsDouble() })

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
				...PROVISIONABLE,
				"systemctl --version | head -n 1": { stdout: "systemd 252", stderr: "", exitCode: 0 },
			}),
		),
		evictHost: () => undefined,
		instanceIdsOnHost: vi.fn(async () => []),
		now: () => new Date(),
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

	it("carries hostKeyTrustedAt, lastSeenAt and teardownRequestedAt as ISO strings, not Date objects", async () => {
		const d = deps()
		vi.mocked(d.hosts.insert).mockResolvedValueOnce(
			makeHostRow({
				hostKeyTrustedAt: new Date("2026-08-30T00:00:00.000Z"),
				lastSeenAt: new Date("2026-09-01T00:00:00.000Z"),
				teardownRequestedAt: new Date("2026-09-02T00:00:00.000Z"),
			}),
		)
		const expected = fingerprintFromKey(DEFAULT_HOST_KEY_BLOB)
		const controller = createHostController(d)

		const created = await controller.enroll(ctx, {
			name: "vps",
			hostname: "10.0.0.1",
			port: 22,
			username: "mcc",
			sshKeyId: "key-1",
			expectedFingerprint: expected,
		})

		expect(created.hostKeyTrustedAt).toBe("2026-08-30T00:00:00.000Z")
		expect(created.lastSeenAt).toBe("2026-09-01T00:00:00.000Z")
		expect(created.teardownRequestedAt).toBe("2026-09-02T00:00:00.000Z")
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
			sshKeyId: "key-1",
			expectedFingerprint: expected,
		})

		expect(d.hosts.insert).toHaveBeenCalledWith(
			{ organizationId: "org-1" },
			expect.objectContaining({ hostKeyAlgorithm: "ssh-rsa" }),
		)
	})
})

const REFUSED_AT_AN_ADDRESS = Object.assign(new Error("connect ECONNREFUSED 203.0.113.9:2222"), {
	code: "ECONNREFUSED",
})

describe("what the dashboard hears when a host cannot be reached", () => {
	const target = {
		hostname: "vps.example.net",
		port: 2222,
		username: "mcc",
		sshKeyId: "key-1",
		expectedFingerprint: "SHA256:x",
	} as const

	it("reports enrolment against a host that does not answer as unreachable, writing nothing", async () => {
		const d = deps({
			probeHostKey: vi.fn(async () => {
				throw new Error("Timed out reading host key from 203.0.113.9:2222")
			}),
		})
		const controller = createHostController(d)

		await expect(controller.enroll(ctx, { name: "vps", ...target })).rejects.toBeInstanceOf(
			HostUnreachableError,
		)
		await expect(controller.enroll(ctx, { name: "vps", ...target })).rejects.not.toThrow(
			/203\.0\.113\.9|2222/,
		)
		expect(d.hosts.insert).not.toHaveBeenCalled()
		expect(d.audit.record).not.toHaveBeenCalled()
	})

	it("says why a host check could not connect without repeating an address the operator never typed", async () => {
		const d = deps({
			createTransport: vi.fn(() => createFakeTransport({}, { connect: REFUSED_AT_AN_ADDRESS })),
		})

		const report = await createHostController(d).checkHost(ctx, target)
		const reachable = report.checks.find((check) => check.name === "reachable")

		expect(reachable?.outcome).toBe("fail")
		expect(reachable?.detail).toBe("The server refused the connection")
	})
})

describe("host controller re-trust", () => {
	it("refuses a role without host.enroll before contacting the host", async () => {
		const d = deps()

		await expect(
			createHostController(d).retrustHostKey({ ...ctx, role: "operator" }, "host-1", {
				hostKeyFingerprint: fingerprintFromKey(DEFAULT_HOST_KEY_BLOB),
			}),
		).rejects.toThrow(/forbidden/i)

		expect(d.probeHostKey).not.toHaveBeenCalled()
		expect(d.hosts.updateHostKeyTrust).not.toHaveBeenCalled()
	})

	it("refuses a host this organization does not have before contacting anything", async () => {
		const d = deps()
		vi.mocked(d.hosts.findById).mockResolvedValueOnce(undefined)

		await expect(
			createHostController(d).retrustHostKey(ctx, "host-elsewhere", {
				hostKeyFingerprint: fingerprintFromKey(DEFAULT_HOST_KEY_BLOB),
			}),
		).rejects.toBeInstanceOf(HostNotFoundError)

		expect(d.probeHostKey).not.toHaveBeenCalled()
	})

	it("refuses a fingerprint the host does not present, without saying which one it presented", async () => {
		const d = deps()
		const presented = fingerprintFromKey(DEFAULT_HOST_KEY_BLOB)

		const refusal = await createHostController(d)
			.retrustHostKey(ctx, "host-1", {
				hostKeyFingerprint: "SHA256:wrongIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrst",
			})
			.then(
				() => undefined,
				(error: Error) => error,
			)

		expect(refusal).toBeInstanceOf(FingerprintMismatchError)
		expect(refusal?.message).not.toContain(presented)
		expect(d.hosts.updateHostKeyTrust).not.toHaveBeenCalled()
		expect(d.audit.record).not.toHaveBeenCalled()
	})

	it("stores the key type the host presents, and audits the fingerprint it matched", async () => {
		const blob = encodeAlgorithmBlob("ssh-rsa", Buffer.from("rsa-rotated-key-material"))
		const expected = fingerprintFromKey(blob)
		const d = deps({ probeHostKey: vi.fn(async () => blob) })

		await createHostController(d).retrustHostKey(ctx, "host-1", { hostKeyFingerprint: expected })

		expect(d.probeHostKey).toHaveBeenCalledWith("10.0.0.1", 22, expect.any(Number))
		expect(d.hosts.updateHostKeyTrust).toHaveBeenCalledWith(
			{ organizationId: "org-1" },
			"host-1",
			expect.objectContaining({ hostKeyAlgorithm: "ssh-rsa", hostKeyFingerprint: expected }),
		)
		expect(d.audit.record).toHaveBeenCalledWith(
			{ organizationId: "org-1" },
			expect.objectContaining({ action: "host.retrust", detail: { fingerprint: expected } }),
		)
	})

	it("says the host is unreachable when its key cannot be read, and changes nothing", async () => {
		const d = deps({
			probeHostKey: vi.fn(async () => {
				throw new Error("Timed out reading host key from 10.0.0.1:22")
			}),
		})

		await expect(
			createHostController(d).retrustHostKey(ctx, "host-1", {
				hostKeyFingerprint: fingerprintFromKey(DEFAULT_HOST_KEY_BLOB),
			}),
		).rejects.toBeInstanceOf(HostUnreachableError)

		expect(d.hosts.updateHostKeyTrust).not.toHaveBeenCalled()
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
				beginTeardown: vi.fn(async () => true),
				recordTeardownFailure: vi.fn(async () => undefined),
				deleteAfterTeardown: vi.fn(async () => true),
				listPollableAcrossOrganizations: vi.fn(async () => []),
				recordSeen: vi.fn(async () => undefined),
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
			beginTeardown: vi.fn(async () => true),
			recordTeardownFailure: vi.fn(async () => undefined),
			deleteAfterTeardown: vi.fn(async () => true),
			listPollableAcrossOrganizations: vi.fn(async () => []),
			recordSeen: vi.fn(async () => undefined),
			updateHostKeyTrust: vi.fn(async () => makeHostRow()),
		}
		const auditRecord = vi.fn(async (_scope: OrgScope, entry: AuditEntry) =>
			makeAuditEventRow({ ...entry }),
		)
		const withTransaction: WithTransaction = async (fn) =>
			fn({ hosts, audit: { record: auditRecord }, jobs: jobsDouble() })
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
					beginTeardown: vi.fn(async () => true),
					recordTeardownFailure: vi.fn(async () => undefined),
					deleteAfterTeardown: vi.fn(async () => true),
					listPollableAcrossOrganizations: vi.fn(async () => []),
					recordSeen: vi.fn(async () => undefined),
					updateHostKeyTrust: vi.fn(async () => makeHostRow()),
				},
				audit: {
					record: vi.fn(async (_scope: OrgScope, entry: AuditEntry) =>
						makeAuditEventRow({ ...entry }),
					),
				},
				jobs: jobsDouble(),
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
					beginTeardown: vi.fn(async () => true),
					recordTeardownFailure: vi.fn(async () => undefined),
					deleteAfterTeardown: vi.fn(async () => true),
					listPollableAcrossOrganizations: vi.fn(async () => []),
					recordSeen: vi.fn(async () => undefined),
					updateHostKeyTrust: vi.fn(async () => makeHostRow()),
				},
				audit: { record: auditRecord },
				jobs: jobsDouble(),
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
			...PROVISIONABLE,
			'. /etc/os-release 2>/dev/null; printf \'%s\\n%s\' "$ID" "$PRETTY_NAME"': {
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
			'install -d -m 0711 "$HOME"/.local/share/open-mcc/instances',
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
			...PROVISIONABLE,
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

		await expect(controller.provision(ctx, "host-1")).rejects.toBeInstanceOf(HostUnreachableError)

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

		await expect(controller.provision(ctx, "host-1")).rejects.toThrow(
			new HostProvisioningFailedError(
				"Could not confirm systemd and a usable home directory on this host.",
			),
		)

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
			await expect(controller.provision(ctx, "host-1")).rejects.toBeInstanceOf(
				HostProvisioningFailedError,
			)
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
		const onError = vi.fn((_message: string, _error: Error | string) => {})
		const d = deps({ createTransport: vi.fn(() => transport), onError })
		const controller = createHostController(d)

		await expect(controller.provision(ctx, "host-1")).rejects.toThrow(
			new HostProvisioningFailedError(
				"Could not confirm systemd and a usable home directory on this host.",
			),
		)
		expect(onError.mock.calls.map(([, error]) => String(error))).toEqual([
			expect.stringMatching(/connection reset/i),
		])

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
			beginTeardown: vi.fn(async () => true),
			recordTeardownFailure: vi.fn(async () => undefined),
			deleteAfterTeardown: vi.fn(async () => true),
			listPollableAcrossOrganizations: vi.fn(async () => []),
			recordSeen: vi.fn(async () => undefined),
			updateHostKeyTrust: vi.fn(async () => makeHostRow()),
		}
		const auditRecord = vi.fn(async (_scope: OrgScope, entry: AuditEntry) =>
			makeAuditEventRow({ ...entry }),
		)
		const withTransaction: WithTransaction = async (fn) =>
			fn({ hosts, audit: { record: auditRecord }, jobs: jobsDouble() })
		const d = deps({ hosts, withTransaction })
		const controller = createHostController(d)

		await expect(controller.remove(ctx, "host-1")).resolves.toBe(true)
		expect(hosts.delete).toHaveBeenCalled()
	})
})

describe("dropping a host's shared connections once a trust change commits", () => {
	const recorded = (d: ReturnType<typeof deps>) => {
		const events: string[] = []
		d.withTransaction = async (fn) => {
			events.push("opened")
			const result = await fn({ hosts: d.hosts, audit: d.audit, jobs: jobsDouble() })
			events.push("committed")
			return result
		}
		d.evictHost = (organizationId, hostId) => {
			events.push(`evicted ${organizationId}:${hostId}`)
		}
		return events
	}

	it("C3: evicts only after the re-trust has committed", async () => {
		const d = deps()
		const events = recorded(d)

		await createHostController(d).retrustHostKey(ctx, "host-1", {
			hostKeyFingerprint: fingerprintFromKey(DEFAULT_HOST_KEY_BLOB),
		})

		expect(events).toEqual(["opened", "committed", "evicted org-1:host-1"])
	})

	it("C3: evicts nothing when the re-trust does not commit", async () => {
		const d = deps()
		const events = recorded(d)
		vi.mocked(d.hosts.updateHostKeyTrust).mockResolvedValueOnce(undefined)

		await expect(
			createHostController(d).retrustHostKey(ctx, "host-1", {
				hostKeyFingerprint: fingerprintFromKey(DEFAULT_HOST_KEY_BLOB),
			}),
		).rejects.toBeInstanceOf(HostNotFoundError)

		expect(events).toEqual(["opened"])
	})

	it("C4: evicts after removing a host that had nothing installed", async () => {
		const d = deps()
		const events = recorded(d)
		vi.mocked(d.hosts.findById).mockResolvedValue(
			makeHostRow({ status: "pending" }),
		)

		await expect(createHostController(d).remove(ctx, "host-1")).resolves.toBe(true)

		expect(d.hosts.delete).toHaveBeenCalled()
		expect(events).toEqual(["opened", "committed", "evicted org-1:host-1"])
	})

	it("C4: evicts after requesting the teardown of a provisioned host", async () => {
		const d = deps()
		const events = recorded(d)
		vi.mocked(d.hosts.findById).mockResolvedValue(
			makeHostRow({
				sshKeyId: "key-1",
				hostKeyFingerprint: "SHA256:trusted",
				osRelease: "Debian GNU/Linux 12 (bookworm)",
				status: "ready",
			}),
		)

		await expect(createHostController(d).remove(ctx, "host-1")).resolves.toBe(true)

		expect(d.hosts.beginTeardown).toHaveBeenCalled()
		expect(events).toEqual(["opened", "committed", "evicted org-1:host-1"])
	})

	it("C5: evicts nothing for an organization naming another's host", async () => {
		const d = deps()
		const events = recorded(d)
		vi.mocked(d.hosts.findById).mockResolvedValue(undefined)
		const outsider = { ...ctx, organizationId: "org-2" }

		await expect(
			createHostController(d).retrustHostKey(outsider, "host-1", {
				hostKeyFingerprint: fingerprintFromKey(DEFAULT_HOST_KEY_BLOB),
			}),
		).rejects.toBeInstanceOf(HostNotFoundError)
		await expect(createHostController(d).remove(outsider, "host-1")).resolves.toBe(false)

		expect(events).toEqual([])
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
			...PROVISIONABLE,
			"systemctl --version | head -n 1": {
				stdout: "systemd 252 (252.22-1~deb12u1)",
				stderr: "",
				exitCode: 0,
			},
		})
		await transport.connect(provisionConnectOptions)
		const result = await provisionHost(transport)
		expect(result.osRelease).toBe("systemd 252 (252.22-1~deb12u1)")
		expect(transport.commands).toContain(
			'install -d -m 0711 "$HOME"/.local/share/open-mcc/instances',
		)
	})

	it("fails when systemd is absent", async () => {
		const transport = createFakeTransport({
			...PROVISIONABLE,
			"systemctl --version | head -n 1": { stdout: "", stderr: "not found", exitCode: 127 },
		})
		await transport.connect(provisionConnectOptions)
		await expect(provisionHost(transport)).rejects.toThrow(/systemd/i)
	})

	it("propagates when exec() rejects mid-command rather than resolving as if disconnected", async () => {
		const transport = createRejectingTransport("exec")
		await expect(provisionHost(transport)).rejects.toThrow(/connection reset/i)
	})

	it("refuses a home directory carrying a shell metacharacter, so a hostile host cannot smuggle a command into every later path", async () => {
		const transport = createFakeTransport({
			...PROVISIONABLE,
			"systemctl --version | head -n 1": { stdout: "systemd 252", stderr: "", exitCode: 0 },
			[HOME_COMMAND]: { stdout: "/home/$(id -u)\n/home/$(id -u)", stderr: "", exitCode: 0 },
		})
		await transport.connect(provisionConnectOptions)

		await expect(provisionHost(transport)).rejects.toThrow(/absolute path/i)
		expect(transport.commands.some((command) => command.includes("curl"))).toBe(false)
		expect(transport.commands.some((command) => command.includes("install -d"))).toBe(false)
	})

	it("refuses a relative home directory rather than resolving it against an unknown working directory", async () => {
		const transport = createFakeTransport({
			...PROVISIONABLE,
			"systemctl --version | head -n 1": { stdout: "systemd 252", stderr: "", exitCode: 0 },
			[HOME_COMMAND]: { stdout: "home/mccuser\nhome/mccuser", stderr: "", exitCode: 0 },
		})
		await transport.connect(provisionConnectOptions)

		await expect(provisionHost(transport)).rejects.toThrow(/absolute path/i)
		expect(transport.commands.some((command) => command.includes("curl"))).toBe(false)
	})

	it("finishes its worst-case remote work inside the provisioning lease, counting every step it actually runs", async () => {
		const transport = createFakeTransport(PROVISIONABLE)
		await transport.connect(provisionConnectOptions)
		await provisionHost(transport)

		const remoteBudgetMs = transport.timeouts.reduce((total, each) => total + each, 0)
		const worstCaseMs = CONNECT_TIMEOUT_MS + remoteBudgetMs
		expect(transport.timeouts).toHaveLength(transport.commands.length)
		expect(worstCaseMs).toBeLessThan(PROVISIONING_LEASE_MS)
	})
})

describe("what provisioning tells the operator when it fails", () => {
	const provisioningHosts = (
		transport: HostTransport,
		onError: HostControllerDeps["onError"] = vi.fn(),
	) => {
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
			beginTeardown: vi.fn(async () => true),
			recordTeardownFailure: vi.fn(async () => undefined),
			deleteAfterTeardown: vi.fn(async () => true),
			listPollableAcrossOrganizations: vi.fn(async () => []),
			recordSeen: vi.fn(async () => undefined),
			updateHostKeyTrust: vi.fn(async () => makeHostRow()),
		}
		const withTransaction: WithTransaction = async (fn) =>
			fn({ hosts, audit: { record: vi.fn(async () => makeAuditEventRow({})) }, jobs: jobsDouble() })
		return {
			hosts,
			controller: createHostController(
				deps({ hosts, withTransaction, createTransport: () => transport, onError }),
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

	it("records why it could not connect without the address the error named", async () => {
		const { controller, hosts } = provisioningHosts(
			createFakeTransport({}, { connect: REFUSED_AT_AN_ADDRESS }),
		)

		await expect(controller.provision(ctx, "host-1")).rejects.toBeInstanceOf(HostUnreachableError)
		expect(hosts.recordProvisioningFailure).toHaveBeenCalledWith(
			expect.anything(),
			"host-1",
			"attempt-1",
			"The server refused the connection",
		)
	})

	it("★ records only its own words for the step that failed, and gives the host's words to the log alone", async () => {
		const onError = vi.fn((_message: string, _error: Error | string) => {})
		const { controller, hosts } = provisioningHosts(
			createFakeTransport({
				"systemctl --version | head -n 1": {
					stdout: "",
					stderr: "curl: (7) Failed to connect to 203.0.113.9 port 2222, token hunter2",
					exitCode: 1,
				},
			}),
			onError,
		)
		const copy = "Could not confirm systemd and a usable home directory on this host."

		await expect(controller.provision(ctx, "host-1")).rejects.toThrow(
			new HostProvisioningFailedError(copy),
		)
		expect(hosts.recordProvisioningFailure).toHaveBeenCalledWith(
			expect.anything(),
			"host-1",
			"attempt-1",
			copy,
		)
		expect(
			onError.mock.calls.map(([, error]) => (error instanceof Error ? error.message : error)),
		).toEqual([expect.stringContaining("203.0.113.9 port 2222")])
	})

	it("★ keeps to its own words when the connection fails part way, whatever the host said", async () => {
		const { controller, hosts } = provisioningHosts(
			createFakeTransport(PROVISIONABLE, {
				exec: { "uname -m": new Error("Command timed out: uname -m on 203.0.113.9:2222") },
			}),
		)

		await expect(controller.provision(ctx, "host-1")).rejects.toBeInstanceOf(
			HostProvisioningFailedError,
		)
		expect(hosts.recordProvisioningFailure).toHaveBeenCalledWith(
			expect.anything(),
			"host-1",
			"attempt-1",
			"This host's processor could not be read, or has no client build.",
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

describe("removing a host that is still in use", () => {
	it("refuses while instances remain, rather than orphaning them on a host it is cleaning", async () => {
		const d = deps({ instanceIdsOnHost: vi.fn(async () => ["abc", "def"]) })
		const controller = createHostController(d)

		await expect(controller.remove(ctx, "host-1")).rejects.toBeInstanceOf(HostHasInstancesError)
		expect(d.hosts.beginTeardown).not.toHaveBeenCalled()
	})

	it("names how many instances are in the way, so the operator knows what to do", async () => {
		const controller = createHostController(deps({ instanceIdsOnHost: vi.fn(async () => ["abc"]) }))

		await expect(controller.remove(ctx, "host-1")).rejects.toThrow(/1 instance/)
	})

	it("marks a host that finished provisioning for teardown, sending only how to reach it, instead of deleting its record", async () => {
		const jobs = jobsDouble()
		const d = deps({ instanceIdsOnHost: vi.fn(async () => []) })
		d.hosts.findById = vi.fn(async () =>
			makeHostRow({ hostKeyFingerprint: "SHA256:trusted", osRelease: "systemd 252" }),
		)
		const controller = createHostController({
			...d,
			withTransaction: async (fn) => fn({ hosts: d.hosts, audit: d.audit, jobs }),
		})

		await expect(controller.remove(ctx, "host-1")).resolves.toBe(true)

		expect(d.hosts.beginTeardown).toHaveBeenCalled()
		expect(d.hosts.delete).not.toHaveBeenCalled()
		expect(jobs.enqueue).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ hostId: "host-1", username: "mcc", sshKeyId: "key-1" }),
		)
		for (const gone of ["mode", "instancesRoot", "unitDir", "instanceIds"]) {
			expect(jobs.enqueue).not.toHaveBeenCalledWith(
				expect.anything(),
				expect.objectContaining({ [gone]: expect.anything() }),
			)
		}
	})

	it("deletes outright when nothing was ever installed, since there is nothing to clean", async () => {
		const d = deps({ instanceIdsOnHost: vi.fn(async () => []) })
		d.hosts.findById = vi.fn(async () =>
			makeHostRow({ hostKeyFingerprint: "SHA256:trusted", osRelease: null }),
		)
		const controller = createHostController(d)

		await expect(controller.remove(ctx, "host-1")).resolves.toBe(true)

		expect(d.hosts.delete).toHaveBeenCalled()
		expect(d.hosts.beginTeardown).not.toHaveBeenCalled()
	})
})
