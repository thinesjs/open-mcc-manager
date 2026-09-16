import {
	type ExpressInstallInput,
	hostSetupScript,
	LOCKED_HAS_NO_PASSWORD,
	LOCKED_KEEPS_PASSWORD,
	lockedNotice,
} from "@open-mcc/contracts"
import type { SshKeyRow } from "@open-mcc/db"
import {
	createFakeRootSession,
	type FakeRootSessionScript,
	RootHostKeyRejectedError,
} from "@open-mcc/transport"
import { describe, expect, it, vi } from "vitest"
import type { AuditEntry, AuditRepository } from "../audit/audit.repository"
import type { SshKeyRepository } from "../ssh-key/ssh-key.repository"
import { auditRowFor, unusedHostRepository } from "../test/host-doubles"
import { EXPRESS_TIMED_OUT_REASON } from "./express-install"
import {
	createHostController,
	type HostControllerDeps,
	SshKeyNotFoundError,
	type WithTransaction,
} from "./host.controller"
import type { OrgScope } from "./host.repository"

const PUBLIC_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI manager key"

const FINGERPRINT = "SHA256:abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPq"

const OTHER_FINGERPRINT = "SHA256:ZZZdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPq"

const ctx = {
	organizationId: "org-1",
	memberId: "mem-1",
	actorLabel: "actor@example.com",
	role: "owner" as const,
}

const sshKeyRow: SshKeyRow = {
	id: "key-1",
	organizationId: "org-1",
	name: "key-1",
	publicKey: PUBLIC_KEY,
	privateKeyEncrypted: "sealed",
	privateKeyKeyId: "k1",
	createdAt: new Date(),
}

const input = (overrides: Partial<ExpressInstallInput> = {}): ExpressInstallInput => ({
	hostname: "203.0.113.9",
	port: 22,
	username: "mcc",
	sshKeyId: "key-1",
	createAccount: true,
	expectedFingerprint: FINGERPRINT,
	credential: { kind: "password", password: "hunter2-root" },
	unlock: false,
	...overrides,
})

const readyStdout = `  key added\n\nHost key fingerprint - paste this into the dashboard:\n${FINGERPRINT}\n`

const harness = (script: FakeRootSessionScript = { result: ready() }) => {
	const session = createFakeRootSession(script)
	const records: AuditEntry[] = []
	const audit: Pick<AuditRepository, "record"> = {
		record: vi.fn(async (_scope: OrgScope, entry: AuditEntry) => {
			records.push(entry)
			return auditRowFor("org-1", entry)
		}),
	}
	const withTransaction: WithTransaction = async (fn) =>
		fn({
			hosts: unusedHostRepository(),
			audit,
			jobs: { enqueue: vi.fn(async () => undefined) },
		})
	const deps: HostControllerDeps = {
		hosts: unusedHostRepository(),
		sshKeys: { findById: vi.fn(async () => sshKeyRow) } satisfies Pick<
			SshKeyRepository,
			"findById"
		>,
		secrets: { activeKeyId: "k1", seal: vi.fn(), open: vi.fn(() => "PRIVATE KEY") },
		probeHostKey: vi.fn(async () => Buffer.alloc(0)),
		probeSshHandshake: vi.fn(async () => ({ kind: "closed" }) as const),
		createTransport: vi.fn(),
		createRootSession: () => session,
		evictHost: () => undefined,
		now: () => new Date(),
		withTransaction,
	}
	return { session, records, controller: createHostController(deps) }
}

function ready() {
	return { stdout: readyStdout, stderr: "", exitCode: 0 }
}

describe("running the setup for an operator who has root", () => {
	it("sends the very script the manual path would have shown, byte for byte", async () => {
		const { session, controller } = harness()

		await controller.expressInstall(ctx, input())

		expect(session.commands).toEqual([hostSetupScript("mcc", PUBLIC_KEY, true, "ask", "none")])
		expect(`sudo ${session.commands[0]}`).toBe(hostSetupScript("mcc", PUBLIC_KEY, true))
	})

	it("asks for no sudo on a connection that is already root, since a host may not have it", async () => {
		const { session, controller } = harness()

		await controller.expressInstall(ctx, input())

		expect(session.commands[0]?.startsWith("sh -s <<'OPENMCC_SETUP'")).toBe(true)
	})

	it("connects as root at the fingerprint the operator confirmed, not one it chose itself", async () => {
		const { session, controller } = harness()

		await controller.expressInstall(ctx, input())

		expect(session.attempts).toHaveLength(1)
		expect(session.attempts[0]?.username).toBe("root")
		expect(session.attempts[0]?.expectedFingerprint).toBe(FINGERPRINT)
	})

	it("closes the session whether the script worked or not", async () => {
		const { session, controller } = harness({ result: { stdout: "", stderr: "", exitCode: 3 } })

		await controller.expressInstall(ctx, input())

		expect(session.closeCount()).toBe(1)
	})

	it("reports the host ready only once the host itself printed the confirmed fingerprint", async () => {
		const { controller } = harness()

		expect(await controller.expressInstall(ctx, input())).toEqual({
			outcome: "ready",
			fingerprint: FINGERPRINT,
		})
	})

	it("refuses to call a host ready when it prints a different key than the one confirmed", async () => {
		const { controller } = harness({
			result: { stdout: `fingerprint\n${OTHER_FINGERPRINT}\n`, stderr: "", exitCode: 0 },
		})

		expect(await controller.expressInstall(ctx, input())).toEqual({ outcome: "key-mismatch" })
	})

	it("says the key did not match when the host presented a different one at connect time", async () => {
		const { controller } = harness({ connect: new RootHostKeyRejectedError("did not match") })

		expect(await controller.expressInstall(ctx, input())).toEqual({ outcome: "key-mismatch" })
	})

	it("says the credential was refused rather than blaming the address", async () => {
		const refused = Object.assign(new Error("All configured authentication methods failed"), {
			level: "client-authentication",
		})
		const { controller } = harness({ connect: refused })

		expect(await controller.expressInstall(ctx, input())).toEqual({ outcome: "refused" })
	})

	it("names what went wrong on the wire so an operator knows where to look", async () => {
		const unreachable = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" })
		const { controller } = harness({ connect: unreachable })

		expect(await controller.expressInstall(ctx, input())).toEqual({
			outcome: "unreachable",
			reason: "The server refused the connection",
		})
	})

	it("tells the operator the setup may still be running when it runs out of time", async () => {
		const { controller } = harness({ run: new Error("Command timed out: the setup script") })

		expect(await controller.expressInstall(ctx, input())).toEqual({
			outcome: "script-failed",
			reason: EXPRESS_TIMED_OUT_REASON,
		})
	})

	it("hands back what the script itself said when the script stopped", async () => {
		const { controller } = harness({
			result: {
				stdout: "",
				stderr: "This distribution isn't supported yet.\n",
				exitCode: 1,
			},
		})

		expect(await controller.expressInstall(ctx, input())).toEqual({
			outcome: "script-failed",
			reason: "This distribution isn't supported yet.",
		})
	})
})

describe("the locked account nobody can be asked about", () => {
	it("reports the lock rather than a bare failure, so the wizard can ask on screen", async () => {
		const { controller } = harness({
			result: {
				stdout: "",
				stderr: `${lockedNotice("mcc")}\n${LOCKED_KEEPS_PASSWORD}\nLeft mcc locked, and changed nothing.\n`,
				exitCode: 1,
			},
		})

		expect(await controller.expressInstall(ctx, input())).toEqual({
			outcome: "locked",
			account: "mcc",
			keepsPassword: true,
		})
	})

	it("distinguishes a locked account with a password from one without", async () => {
		const { controller } = harness({
			result: {
				stdout: "",
				stderr: `${lockedNotice("mcc")}\n${LOCKED_HAS_NO_PASSWORD}\n`,
				exitCode: 1,
			},
		})

		expect(await controller.expressInstall(ctx, input())).toEqual({
			outcome: "locked",
			account: "mcc",
			keepsPassword: false,
		})
	})

	it("asks nothing on the wire until the operator has answered, then carries the answer", async () => {
		const first = harness({
			result: { stdout: "", stderr: `${lockedNotice("mcc")}\n`, exitCode: 1 },
		})
		await first.controller.expressInstall(ctx, input())

		const second = harness()
		await second.controller.expressInstall(ctx, input({ unlock: true }))

		expect(first.session.commands[0]).toBe(hostSetupScript("mcc", PUBLIC_KEY, true, "ask", "none"))
		expect(second.session.commands[0]).toBe(
			hostSetupScript("mcc", PUBLIC_KEY, true, "grant", "none"),
		)
	})
})

describe("what an Express install leaves behind", () => {
	it("records who ran it and against which host", async () => {
		const { records, controller } = harness()

		await controller.expressInstall(ctx, input())

		expect(records).toHaveLength(1)
		expect(records[0]?.action).toBe("host.express")
		expect(records[0]?.actorId).toBe("mem-1")
		expect(records[0]?.actorLabel).toBe("actor@example.com")
		expect(records[0]?.subjectId).toBe("203.0.113.9")
		expect(records[0]?.detail.outcome).toBe("ready")
		expect(records[0]?.detail.credentialKind).toBe("password")
	})

	it("records the attempt even when the server refused it", async () => {
		const refused = Object.assign(new Error("auth failed"), { level: "client-authentication" })
		const { records, controller } = harness({ connect: refused })

		await controller.expressInstall(ctx, input())

		expect(records).toHaveLength(1)
		expect(records[0]?.detail.outcome).toBe("refused")
	})

	it("keeps every SSH step outside the transaction that writes the audit row", async () => {
		const order: string[] = []
		const session = createFakeRootSession({ result: ready() })
		const watched = {
			...session,
			connect: async (options: Parameters<typeof session.connect>[0]) => {
				order.push("ssh")
				return session.connect(options)
			},
			run: async (command: string, timeoutMs: number) => {
				order.push("ssh")
				return session.run(command, timeoutMs)
			},
		}
		const withTransaction: WithTransaction = async (fn) => {
			order.push("transaction-open")
			const value = await fn({
				hosts: unusedHostRepository(),
				audit: {
					record: vi.fn(async (_scope: OrgScope, entry: AuditEntry) => {
						order.push("audit")
						return auditRowFor("org-1", entry)
					}),
				},
				jobs: { enqueue: vi.fn(async () => undefined) },
			})
			order.push("transaction-close")
			return value
		}
		const controller = createHostController({
			hosts: unusedHostRepository(),
			sshKeys: { findById: vi.fn(async () => sshKeyRow) },
			secrets: { activeKeyId: "k1", seal: vi.fn(), open: vi.fn(() => "PRIVATE KEY") },
			probeHostKey: vi.fn(async () => Buffer.alloc(0)),
			probeSshHandshake: vi.fn(async () => ({ kind: "closed" }) as const),
			createTransport: vi.fn(),
			createRootSession: () => watched,
			evictHost: () => undefined,
			now: () => new Date(),
			withTransaction,
		})

		await controller.expressInstall(ctx, input())

		expect(order).toEqual(["ssh", "ssh", "transaction-open", "audit", "transaction-close"])
	})
})

describe("who may run an Express install", () => {
	it("is gated exactly as the rest of enrolment is", async () => {
		const { session, controller } = harness()

		await expect(
			controller.expressInstall({ ...ctx, role: "operator" }, input()),
		).rejects.toThrowError(/host.enroll/)
		expect(session.attempts).toHaveLength(0)
	})

	it("refuses a key that is not this organization's", async () => {
		const session = createFakeRootSession()
		const controller = createHostController({
			hosts: unusedHostRepository(),
			sshKeys: { findById: vi.fn(async () => undefined) },
			secrets: { activeKeyId: "k1", seal: vi.fn(), open: vi.fn(() => "PRIVATE KEY") },
			probeHostKey: vi.fn(async () => Buffer.alloc(0)),
			probeSshHandshake: vi.fn(async () => ({ kind: "closed" }) as const),
			createTransport: vi.fn(),
			createRootSession: () => session,
			evictHost: () => undefined,
			now: () => new Date(),
			withTransaction: async (fn) =>
				fn({
					hosts: unusedHostRepository(),
					audit: {
						record: vi.fn(async (_scope: OrgScope, entry: AuditEntry) =>
							auditRowFor("org-1", entry),
						),
					},
					jobs: { enqueue: vi.fn(async () => undefined) },
				}),
		})

		await expect(controller.expressInstall(ctx, input())).rejects.toBeInstanceOf(
			SshKeyNotFoundError,
		)
		expect(session.attempts).toHaveLength(0)
	})
})

describe("reading a host key before any credential is offered", () => {
	it("is gated exactly as the rest of enrolment is", async () => {
		const { controller } = harness()

		await expect(
			controller.readHostKey({ ...ctx, role: "operator" }, { hostname: "h", port: 22 }),
		).rejects.toThrowError(/host.enroll/)
	})
})
