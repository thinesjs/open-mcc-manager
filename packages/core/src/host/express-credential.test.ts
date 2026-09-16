import type { ExpressInstallInput, ExpressInstallResult } from "@open-mcc/contracts"
import type { SshKeyRow } from "@open-mcc/db"
import { createFakeRootSession, type FakeRootSessionScript } from "@open-mcc/transport"
import { sql } from "kysely"
import { afterAll, describe, expect, it, vi } from "vitest"
import { REDACTED_CREDENTIAL, redactError } from "../security/redact"
import { seedMember, seedOrganization, teardownTestDb, testDb } from "../test/db"
import { unusedHostRepository } from "../test/host-doubles"
import { EXPRESS_TIMED_OUT_REASON } from "./express-install"
import {
	createHostController,
	createHostControllerTransaction,
	type HostControllerDeps,
} from "./host.controller"

const ROOT_PASSWORD = "sup3rs3cret-r00t-pw-9f3c1a7b4e2d"

const ROOT_PRIVATE_KEY = `-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW
QjustEnoughMaterialToLookLikeARealKey9f3c1a7b4e2dAAAAAAAAAAAAAAAAAAAA
-----END OPENSSH PRIVATE KEY-----`

const FINGERPRINT = "SHA256:abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPq"

const PUBLIC_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI manager key"

const READY_STDOUT = `Host key fingerprint - paste this into the dashboard:\n${FINGERPRINT}\n`

const sshKeyRow: SshKeyRow = {
	id: "key-1",
	organizationId: "org-1",
	name: "key-1",
	publicKey: PUBLIC_KEY,
	privateKeyEncrypted: "sealed",
	privateKeyKeyId: "k1",
	createdAt: new Date(),
}

const inputWith = (
	credential: ExpressInstallInput["credential"],
	overrides: Partial<ExpressInstallInput> = {},
): ExpressInstallInput => ({
	hostname: "198.51.100.4",
	port: 22,
	username: "mcc",
	sshKeyId: "key-1",
	createAccount: true,
	expectedFingerprint: FINGERPRINT,
	credential,
	unlock: false,
	...overrides,
})

type Captured = {
	result: ExpressInstallResult
	logs: string
}

type RecordLine = (value: string) => void

const captureOutput = async <T>(
	fn: (record: RecordLine) => Promise<T>,
): Promise<{ result: T; logs: string }> => {
	const lines: string[] = []
	const record: RecordLine = (value) => {
		lines.push(value)
	}
	const stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
		record(String(chunk))
		return true
	})
	const stderr = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
		record(String(chunk))
		return true
	})
	const consoles = (["log", "info", "warn", "error", "debug"] as const).map((name) =>
		vi.spyOn(console, name).mockImplementation((...args) => {
			for (const arg of args) record(String(arg))
		}),
	)

	try {
		return { result: await fn(record), logs: lines.join("\n") }
	} finally {
		stdout.mockRestore()
		stderr.mockRestore()
		for (const spy of consoles) spy.mockRestore()
	}
}

const depsFor = (
	organizationId: string,
	script: FakeRootSessionScript,
	record: RecordLine,
): HostControllerDeps => ({
	hosts: unusedHostRepository(),
	sshKeys: { findById: vi.fn(async () => ({ ...sshKeyRow, organizationId })) },
	secrets: { activeKeyId: "k1", seal: vi.fn(), open: vi.fn(() => "PRIVATE KEY") },
	probeHostKey: vi.fn(async () => Buffer.alloc(0)),
	probeSshHandshake: vi.fn(async () => ({ kind: "closed" }) as const),
	createTransport: vi.fn(),
	createRootSession: () => createFakeRootSession(script),
	evictHost: () => undefined,
	now: () => new Date(),
	withTransaction: createHostControllerTransaction(testDb(), async () => null),
	onError: (message, error) => record(`${message} ${redactError(error)}`),
})

const runInstall = async (
	organizationId: string,
	memberId: string,
	credential: ExpressInstallInput["credential"],
	script: FakeRootSessionScript,
): Promise<Captured> =>
	captureOutput((record) =>
		createHostController(depsFor(organizationId, script, record)).expressInstall(
			{ organizationId, memberId, actorLabel: "actor@example.com", role: "owner" },
			inputWith(credential),
		),
	)

const dumpDatabase = async (): Promise<string> => {
	const db = testDb()
	const tables = await sql<{ table_name: string }>`
		select table_name from information_schema.tables
		where table_schema = 'public' and table_type = 'BASE TABLE'
	`.execute(db)
	const dumps: string[] = []
	for (const { table_name } of tables.rows) {
		const rows = await sql<{ line: string }>`
			select coalesce(string_agg(row_to_json(t)::text, ' '), '') as line
			from ${sql.table(table_name)} as t
		`.execute(db)
		dumps.push(rows.rows[0]?.line ?? "")
	}
	return dumps.join("\n")
}

const scenarios: ReadonlyArray<readonly [string, FakeRootSessionScript]> = [
	[
		"the connection is refused with the credential echoed back",
		{
			connect: Object.assign(
				new Error(`Authentication failed for root with ${ROOT_PASSWORD} / ${ROOT_PRIVATE_KEY}`),
				{ level: "client-authentication" },
			),
		},
	],
	[
		"the connection never completes",
		{ connect: new Error(`Connection timed out while offering ${ROOT_PASSWORD}`) },
	],
	[
		"the script times out",
		{ run: new Error(`Command timed out: the setup script for ${ROOT_PASSWORD}`) },
	],
	[
		"the script fails and echoes the credential in its own output",
		{
			result: {
				stdout: "",
				stderr: `su: authentication failure using ${ROOT_PASSWORD}\n${ROOT_PRIVATE_KEY}\n`,
				exitCode: 1,
			},
		},
	],
	["the script succeeds", { result: { stdout: READY_STDOUT, stderr: "", exitCode: 0 } }],
]

describe("the evidence these tests rest on", () => {
	it("really reads the rows in the database, rather than an empty dump", async () => {
		const organizationId = await seedOrganization("express-canary")

		const dump = await dumpDatabase()

		expect(dump).toContain(organizationId)
		expect(dump.length).toBeGreaterThan(organizationId.length)
	})

	it("really sees a line written to stdout, stderr or the console", async () => {
		const { logs } = await captureOutput(async () => {
			process.stdout.write("canary-stdout\n")
			process.stderr.write("canary-stderr\n")
			console.error("canary-console")
			return null
		})

		expect(logs).toContain("canary-stdout")
		expect(logs).toContain("canary-stderr")
		expect(logs).toContain("canary-console")
	})

	it("really sees a line the controller reports through the reporter it is given", async () => {
		const { logs } = await captureOutput(async (record) => {
			const reporter = depsFor("org-canary", { run: new Error("unused") }, record).onError

			expect(reporter).toBeDefined()
			reporter?.("canary-reported", new Error("canary-onError"))
			return null
		})

		expect(logs).toContain("canary-reported")
		expect(logs).toContain("canary-onError")
	})
})

describe("a root credential that passes through an Express install", () => {
	afterAll(async () => {
		await teardownTestDb()
	})

	for (const [name, script] of scenarios) {
		it(`reaches neither the database nor a log line when ${name}`, async () => {
			const organizationId = await seedOrganization("express-cred")
			const memberId = await seedMember(organizationId)

			const password = await runInstall(
				organizationId,
				memberId,
				{ kind: "password", password: ROOT_PASSWORD },
				script,
			)
			const key = await runInstall(
				organizationId,
				memberId,
				{ kind: "key", privateKey: ROOT_PRIVATE_KEY },
				script,
			)

			const dump = await dumpDatabase()

			expect(dump).toContain("host.express")
			expect(dump).toContain(organizationId)
			expect(dump).not.toContain(ROOT_PASSWORD)
			expect(dump).not.toContain(ROOT_PRIVATE_KEY)
			expect(password.logs).not.toContain(ROOT_PASSWORD)
			expect(key.logs).not.toContain(ROOT_PRIVATE_KEY)
			expect(JSON.stringify(password.result)).not.toContain(ROOT_PASSWORD)
			expect(JSON.stringify(key.result)).not.toContain(ROOT_PRIVATE_KEY)
		})
	}

	it("writes an audit row for the attempt that names the kind of credential but never its value", async () => {
		const organizationId = await seedOrganization("express-audit")
		const memberId = await seedMember(organizationId)

		await runInstall(
			organizationId,
			memberId,
			{ kind: "password", password: ROOT_PASSWORD },
			{ result: { stdout: READY_STDOUT, stderr: "", exitCode: 0 } },
		)

		const rows = await testDb()
			.selectFrom("auditEvent")
			.selectAll()
			.where("organizationId", "=", organizationId)
			.execute()

		expect(rows).toHaveLength(1)
		expect(rows[0]?.action).toBe("host.express")
		expect(rows[0]?.detail.credentialKind).toBe("password")
		expect(JSON.stringify(rows[0])).not.toContain(ROOT_PASSWORD)
	})

	it("replaces the credential the script echoed rather than passing it through to the operator", async () => {
		const organizationId = await seedOrganization("express-echo")
		const memberId = await seedMember(organizationId)

		const { result } = await runInstall(
			organizationId,
			memberId,
			{ kind: "password", password: ROOT_PASSWORD },
			{
				result: {
					stdout: "",
					stderr: `su: authentication failure using ${ROOT_PASSWORD}\n`,
					exitCode: 1,
				},
			},
		)

		expect(result).toEqual({
			outcome: "script-failed",
			reason: `su: authentication failure using ${REDACTED_CREDENTIAL}`,
		})
	})

	it("replaces the credential a transport error carried rather than passing it through", async () => {
		const organizationId = await seedOrganization("express-throw")
		const memberId = await seedMember(organizationId)

		const { result } = await runInstall(
			organizationId,
			memberId,
			{ kind: "password", password: ROOT_PASSWORD },
			{ run: new Error(`channel died holding ${ROOT_PASSWORD}`) },
		)

		expect(result).toEqual({
			outcome: "script-failed",
			reason: `channel died holding ${REDACTED_CREDENTIAL}`,
		})
	})

	it("never quotes the error's own text back when a connection fails, whatever it holds", async () => {
		const organizationId = await seedOrganization("express-connect")
		const memberId = await seedMember(organizationId)

		const { result } = await runInstall(
			organizationId,
			memberId,
			{ kind: "password", password: ROOT_PASSWORD },
			{
				connect: Object.assign(new Error(`getaddrinfo ENOTFOUND ${ROOT_PASSWORD}`), {
					code: "ENOTFOUND",
				}),
			},
		)

		expect(result).toEqual({
			outcome: "unreachable",
			reason: "That address could not be found",
		})
	})

	it("says the setup may still be running without repeating what it was holding", async () => {
		const organizationId = await seedOrganization("express-slow")
		const memberId = await seedMember(organizationId)

		const { result } = await runInstall(
			organizationId,
			memberId,
			{ kind: "password", password: ROOT_PASSWORD },
			{ run: new Error(`Command timed out: the setup script ${ROOT_PASSWORD}`) },
		)

		expect(result).toEqual({
			outcome: "script-failed",
			reason: EXPRESS_TIMED_OUT_REASON,
		})
	})
})
