import { createFakeTransport, type HostTransport } from "@open-mcc/transport"
import { describe, expect, it, vi } from "vitest"
import { podmanImageId, runtimeImageFor } from "../host/runtime-image"
import { createHostTeardownHandler } from "./host-teardown.job"

const payload = {
	hostId: "host-1",
	hostname: "vps.example.net",
	port: "2222",
	username: "mcc",
	sshKeyId: "key-1",
	hostKeyFingerprint: "SHA256:x",
	organizationId: "org-1",
}

const LIST_UNITS = 'ls -1 "$HOME"/.config/systemd/user 2>/dev/null || true'

const REMOVE_FILES = `timeout -k 5 50 sh -c '{ [ ! -e "$HOME"/.local/share/open-mcc ] || chmod -R u+rwX -- "$HOME"/.local/share/open-mcc; } && rm -rf -- "$HOME"/.local/share/open-mcc'; s=$?; exit $s`

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
	const onCleaned = vi.fn(
		async (_hostId: string, _organizationId: string, _summary: Record<string, string>) => {},
	)
	const handler = createHostTeardownHandler({
		openKey: async () => ({ privateKey: "PRIVATE KEY" }),
		connect: async () => await connectedTo(transport),
		onCleaned,
		onFailed,
		onError,
	})
	return { handler, onFailed, onError, onCleaned }
}

describe("what a clean-up needs to know about the host", () => {
	it("removes whichever pinned runtime image the host holds, from a payload that names no architecture", async () => {
		const transport = createFakeTransport()
		const { handler, onCleaned } = cleaningWith(transport)

		await handler(payload)

		expect(transport.commands.filter((command) => command.includes("podman rmi"))).toEqual([
			`timeout -k 3 10 podman rmi --ignore ${podmanImageId(runtimeImageFor("arm64"))} ${podmanImageId(runtimeImageFor("x64"))}; s=$?; exit $s`,
		])
		expect(onCleaned).toHaveBeenCalledTimes(1)
	})

	it("cleans a host from a payload that names only how to reach it", async () => {
		const transport = createFakeTransport()
		const { handler, onCleaned, onFailed } = cleaningWith(transport)

		await handler(payload)

		expect(transport.commands).toContain(REMOVE_FILES)
		expect(onCleaned).toHaveBeenCalledTimes(1)
		expect(onFailed).not.toHaveBeenCalled()
	})

	it("cleans the account's own home, never a path an old queued payload still names", async () => {
		const transport = createFakeTransport()
		const { handler, onCleaned, onFailed } = cleaningWith(transport)

		await handler({
			...payload,
			mode: "system",
			instancesRoot: "/srv/open-mcc",
			unitDir: "/etc/systemd/system",
		})

		expect(transport.commands).toContain(REMOVE_FILES)
		expect(
			transport.commands.filter((command) =>
				/\/srv\/open-mcc|\/etc\/systemd\/system/.test(command),
			),
		).toEqual([])
		expect(onCleaned).toHaveBeenCalledTimes(1)
		expect(onFailed).not.toHaveBeenCalled()
	})
})

describe("★ what a clean-up that got onto the host records for the dashboard", () => {
	it("records only its own words when something is left behind, and gives the details to the log", async () => {
		const { handler, onFailed, onError } = cleaningWith(
			createFakeTransport({ [REMOVE_FILES]: { stdout: "", stderr: "", exitCode: 1 } }),
		)

		await expect(handler(payload)).rejects.toThrow()
		expect(onFailed.mock.calls.map(([, , reason]) => reason)).toEqual([
			"Some of what was installed is still on the host.",
		])
		expect(onError.mock.calls.map(([, error]) => String(error))).toEqual([
			expect.stringContaining(".local/share/open-mcc"),
		])
	})

	it("records only its own words when the connection fails part way through", async () => {
		const { handler, onFailed, onError } = cleaningWith(
			createFakeTransport(
				{},
				{
					exec: {
						[LIST_UNITS]: new Error("read ECONNRESET 203.0.113.9:2222"),
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

	it("★ throws when the channel drops while the files are being deleted, leaving the retry to the queue", async () => {
		const { handler, onFailed, onCleaned } = cleaningWith(
			createFakeTransport(
				{},
				{ exec: { [REMOVE_FILES]: new Error("read ECONNRESET 203.0.113.9:2222") } },
			),
		)

		await expect(handler(payload)).rejects.toThrow("ECONNRESET")
		expect(onCleaned).not.toHaveBeenCalled()
		expect(onFailed.mock.calls.map(([, , reason]) => reason)).toEqual([
			"Cleaning stopped before it finished.",
		])
	})
})
