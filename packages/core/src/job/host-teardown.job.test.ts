import { createFakeTransport, type HostTransport } from "@open-mcc/transport"
import { describe, expect, it, vi } from "vitest"
import { createHostTeardownHandler } from "./host-teardown.job"

const payload = {
	hostId: "host-1",
	hostname: "vps.example.net",
	port: "2222",
	username: "mcc",
	sshKeyId: "key-1",
	hostKeyFingerprint: "SHA256:x",
	mode: "system",
	instancesRoot: "/srv/open-mcc",
	unitDir: "/etc/systemd/system",
	instanceIds: "",
	organizationId: "org-1",
}

describe("what a failed host clean-up records for the dashboard", () => {
	it("records why it could not reach the host without the address the error named", async () => {
		const onFailed = vi.fn(async (_hostId: string, _organizationId: string, _reason: string) => {})
		const handler = createHostTeardownHandler({
			openKey: async () => ({ privateKey: "PRIVATE KEY" }),
			connect: async () => {
				throw Object.assign(new Error("connect ECONNREFUSED 203.0.113.9:2222"), {
					code: "ECONNREFUSED",
				})
			},
			onCleaned: async () => {},
			onFailed,
		})

		await expect(handler(payload)).rejects.toThrow()
		expect(onFailed).toHaveBeenCalledWith("host-1", "org-1", "The server refused the connection")
	})
})

const connectedTo = async (transport: HostTransport): Promise<HostTransport> => {
	await transport.connect({
		hostname: payload.hostname,
		port: 2222,
		username: payload.username,
		privateKey: "PRIVATE KEY",
		expectedFingerprint: payload.hostKeyFingerprint,
		timeoutMs: 1,
	})
	return transport
}

const cleaningWith = (transport: HostTransport) => {
	const onFailed = vi.fn(async (_hostId: string, _organizationId: string, _reason: string) => {})
	const onError = vi.fn((_message: string, _error: Error | string) => {})
	const handler = createHostTeardownHandler({
		openKey: async () => ({ privateKey: "PRIVATE KEY" }),
		connect: async () => await connectedTo(transport),
		onCleaned: async () => {},
		onFailed,
		onError,
	})
	return { handler, onFailed, onError }
}

describe("★ what a clean-up that got onto the host records for the dashboard", () => {
	it("records only its own words when something is left behind, and gives the details to the log", async () => {
		const { handler, onFailed, onError } = cleaningWith(
			createFakeTransport({
				"test -e '/srv/open-mcc' && printf present || printf gone": {
					stdout: "present",
					stderr: "",
					exitCode: 0,
				},
			}),
		)

		await expect(handler(payload)).rejects.toThrow()
		expect(onFailed.mock.calls.map(([, , reason]) => reason)).toEqual([
			"Some of what was installed is still on the host.",
		])
		expect(onError.mock.calls.map(([, error]) => String(error))).toEqual([
			expect.stringContaining("/srv/open-mcc"),
		])
	})

	it("records only its own words when the connection fails part way through", async () => {
		const { handler, onFailed, onError } = cleaningWith(
			createFakeTransport(
				{},
				{
					exec: {
						"ls -1 '/etc/systemd/system' 2>/dev/null || true": new Error(
							"read ECONNRESET 203.0.113.9:2222",
						),
					},
				},
			),
		)

		await expect(handler(payload)).rejects.toThrow()
		expect(onFailed.mock.calls.map(([, , reason]) => reason)).toEqual([
			"Cleaning stopped before it finished.",
		])
		expect(onError.mock.calls.map(([, error]) => String(error))).toEqual([
			expect.stringContaining("203.0.113.9:2222"),
		])
	})
})
