import { fingerprintFromKey } from "@open-mcc/contracts/boundary/ssh"
import { describe, expect, it } from "vitest"
import type { ExecChannel } from "./exec"
import {
	createRootSession,
	type RootClient,
	type RootClientSettings,
	RootHostKeyRejectedError,
	type RootSessionOptions,
	SETUP_SCRIPT_LABEL,
} from "./root-session"

const HOST_KEY = Buffer.from("a host key blob")

const FINGERPRINT = fingerprintFromKey(HOST_KEY)

const SCRIPT = "sudo sh -s <<'OPENMCC_SETUP'\nsecretless script body\nOPENMCC_SETUP"

type Recorded = {
	client: RootClient
	settings: RootClientSettings[]
	commands: string[]
	destroys: () => number
	ready: () => void
	fail: (error: Error) => void
	verify: (key: Buffer) => boolean
}

const recordingClient = (
	onExec: (
		command: string,
		callback: (error: Error | undefined, channel: ExecChannel | undefined) => void,
	) => void = () => undefined,
): Recorded => {
	const settings: RootClientSettings[] = []
	const commands: string[] = []
	let destroys = 0
	let readyListener: () => void = () => undefined
	let errorListener: (error: Error) => void = () => undefined

	const client: RootClient = {
		onReady: (listener) => {
			readyListener = listener
		},
		onError: (listener) => {
			errorListener = listener
		},
		connect: (value) => {
			settings.push(value)
		},
		exec: (command, callback) => {
			commands.push(command)
			onExec(command, callback)
		},
		destroy: () => {
			destroys += 1
		},
	}

	return {
		client,
		settings,
		commands,
		destroys: () => destroys,
		ready: () => readyListener(),
		fail: (error) => errorListener(error),
		verify: (key) => settings[0]?.hostVerifier(key) ?? false,
	}
}

const options = (overrides: Partial<RootSessionOptions> = {}): RootSessionOptions => ({
	hostname: "203.0.113.7",
	port: 22,
	username: "root",
	credential: { kind: "password", password: "a-root-password" },
	expectedFingerprint: FINGERPRINT,
	timeoutMs: 1_000,
	...overrides,
})

describe("the one-shot session an Express install runs as root over", () => {
	it("offers a password as a password and never as a key", async () => {
		const recorded = recordingClient()
		const session = createRootSession(() => recorded.client)

		const connecting = session.connect(options())
		recorded.ready()
		await connecting

		expect(recorded.settings[0]).toMatchObject({ password: "a-root-password" })
		expect(recorded.settings[0]).not.toHaveProperty("privateKey")
	})

	it("offers a key as a key and never as a password", async () => {
		const recorded = recordingClient()
		const session = createRootSession(() => recorded.client)

		const connecting = session.connect(
			options({ credential: { kind: "key", privateKey: "PEM MATERIAL" } }),
		)
		recorded.ready()
		await connecting

		expect(recorded.settings[0]).toMatchObject({ privateKey: "PEM MATERIAL" })
		expect(recorded.settings[0]).not.toHaveProperty("password")
	})

	it("accepts the host key the operator confirmed", async () => {
		const recorded = recordingClient()
		const session = createRootSession(() => recorded.client)

		const connecting = session.connect(options())
		expect(recorded.verify(HOST_KEY)).toBe(true)
		recorded.ready()
		await connecting
	})

	it("turns down any other host key, so ssh2 stops before it offers the credential", async () => {
		const recorded = recordingClient()
		const session = createRootSession(() => recorded.client)

		const connecting = session.connect(options())
		expect(recorded.verify(Buffer.from("a different host"))).toBe(false)
		recorded.fail(new Error("Handshake failed: host denied"))

		await expect(connecting).rejects.toBeInstanceOf(RootHostKeyRejectedError)
	})

	it("keeps the transport's own error when the key was fine and the credential was not", async () => {
		const recorded = recordingClient()
		const session = createRootSession(() => recorded.client)
		const refused = new Error("All configured authentication methods failed")

		const connecting = session.connect(options())
		recorded.verify(HOST_KEY)
		recorded.fail(refused)

		await expect(connecting).rejects.toBe(refused)
	})

	it("gives up and drops the client when the host never answers", async () => {
		const recorded = recordingClient()
		const session = createRootSession(() => recorded.client)

		await expect(session.connect(options({ timeoutMs: 1 }))).rejects.toThrowError(/timed out/)
		expect(recorded.destroys()).toBe(1)
	})

	it("runs the command it was given, whole", async () => {
		const recorded = recordingClient((_command, callback) => {
			callback(undefined, channelReturning("done", "", 0))
		})
		const session = createRootSession(() => recorded.client)

		const connecting = session.connect(options())
		recorded.ready()
		await connecting

		expect(await session.run(SCRIPT, 1_000)).toEqual({
			stdout: "done",
			stderr: "",
			exitCode: 0,
		})
		expect(recorded.commands).toEqual([SCRIPT])
	})

	it("names the script rather than quoting it when a channel cannot be opened", async () => {
		const recorded = recordingClient((_command, callback) => {
			callback(new Error("open failed: administratively prohibited"), undefined)
		})
		const session = createRootSession(() => recorded.client)

		const connecting = session.connect(options())
		recorded.ready()
		await connecting

		await expect(session.run(SCRIPT, 1_000)).rejects.toThrowError(new RegExp(SETUP_SCRIPT_LABEL))
		await expect(session.run(SCRIPT, 1_000)).rejects.not.toThrowError(/OPENMCC_SETUP/)
	})

	it("refuses to run anything once it has been closed", async () => {
		const recorded = recordingClient()
		const session = createRootSession(() => recorded.client)

		const connecting = session.connect(options())
		recorded.ready()
		await connecting
		session.close()

		expect(recorded.destroys()).toBe(1)
		await expect(session.run(SCRIPT, 1_000)).rejects.toThrowError(/not connected/)
	})
})

function channelReturning(stdout: string, stderr: string, exitCode: number): ExecChannel {
	let onClose: (code: number | null | undefined, signal: string | undefined) => void = () =>
		undefined
	let onStdout: (chunk: Buffer) => void = () => undefined
	let onStderr: (chunk: Buffer) => void = () => undefined
	return {
		write: () => undefined,
		end: () => {
			onStdout(Buffer.from(stdout))
			onStderr(Buffer.from(stderr))
			onClose(exitCode, undefined)
		},
		onStdout: (listener) => {
			onStdout = listener
		},
		onStderr: (listener) => {
			onStderr = listener
		},
		onClose: (listener) => {
			onClose = listener
		},
		destroy: () => undefined,
	}
}
