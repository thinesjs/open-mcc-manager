import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { execWithBoundedAcquisition, type RequestChannel } from "./connection"
import {
	ChannelLimitReachedError,
	CommandAbortedError,
	type ExecChannel,
	isChannelExhaustion,
	namedChannelError,
} from "./exec"

type FakeExecChannel = {
	channel: ExecChannel
	emitStdout: (chunk: Buffer) => void
	emitClose: (exitCode: number | null | undefined, signal?: string) => void
	wasDestroyed: () => boolean
}

const createFakeExecChannel = (): FakeExecChannel => {
	let onStdout: ((chunk: Buffer) => void) | undefined
	let onClose:
		| ((exitCode: number | null | undefined, signal: string | undefined) => void)
		| undefined
	let destroyed = false

	return {
		channel: {
			write: () => {},
			end: () => {},
			onStdout: (listener) => {
				onStdout = listener
			},
			onStderr: () => {},
			onClose: (listener) => {
				onClose = listener
			},
			destroy: () => {
				destroyed = true
			},
		},
		emitStdout: (chunk) => onStdout?.(chunk),
		emitClose: (exitCode, signal) => onClose?.(exitCode, signal),
		wasDestroyed: () => destroyed,
	}
}

beforeEach(() => {
	vi.useFakeTimers()
})

afterEach(() => {
	vi.useRealTimers()
})

describe("execWithBoundedAcquisition", () => {
	it("resolves normally when the channel is granted promptly and the command completes", async () => {
		const fake = createFakeExecChannel()
		const requestChannel: RequestChannel = (_command, callback) => callback(undefined, fake.channel)

		const resultPromise = execWithBoundedAcquisition(requestChannel, "echo hi", 1000)
		fake.emitStdout(Buffer.from("hi\n"))
		fake.emitClose(0)

		await expect(resultPromise).resolves.toEqual({ stdout: "hi\n", stderr: "", exitCode: 0 })
	})

	it("propagates a signal-killed command as a rejection rather than a successful result", async () => {
		const fake = createFakeExecChannel()
		const requestChannel: RequestChannel = (_command, callback) => callback(undefined, fake.channel)

		const resultPromise = execWithBoundedAcquisition(requestChannel, "docker --version", 1000)
		const assertion = expect(resultPromise).rejects.toBeInstanceOf(CommandAbortedError)
		fake.emitClose(null, "SIGTERM")
		await assertion
	})

	it("rejects at the timeout, rather than hanging, when the channel is never granted", async () => {
		const requestChannel: RequestChannel = () => {}

		const resultPromise = execWithBoundedAcquisition(requestChannel, "docker --version", 1000)
		const assertion = expect(resultPromise).rejects.toThrow(/timed out waiting for a channel/i)
		await vi.advanceTimersByTimeAsync(1000)

		await assertion
	})

	it("propagates a channel-acquisition error instead of waiting out the timeout", async () => {
		const requestChannel: RequestChannel = (_command, callback) =>
			callback(new Error("channel open failed"), undefined)

		const resultPromise = execWithBoundedAcquisition(requestChannel, "echo hi", 1000)

		await expect(resultPromise).rejects.toThrow(ChannelLimitReachedError)
	})

	it("keeps an acquisition error that is not about channels unchanged", async () => {
		const requestChannel: RequestChannel = (_command, callback) =>
			callback(new Error("connection reset by peer"), undefined)

		await expect(execWithBoundedAcquisition(requestChannel, "echo hi", 1000)).rejects.toThrow(
			/connection reset/i,
		)
	})

	it("bounds the total time across acquisition and execution, not just execution", async () => {
		const fake = createFakeExecChannel()
		let deliverChannel: (() => void) | undefined
		const requestChannel: RequestChannel = (_command, callback) => {
			deliverChannel = () => callback(undefined, fake.channel)
		}

		const resultPromise = execWithBoundedAcquisition(requestChannel, "echo hi", 1000)
		const assertion = expect(resultPromise).rejects.toThrow(/timed out/i)

		await vi.advanceTimersByTimeAsync(900)
		deliverChannel?.()
		await vi.advanceTimersByTimeAsync(200)

		await assertion
		expect(fake.wasDestroyed()).toBe(true)
	})

	it("destroys a channel that arrives after the acquisition timeout has already fired", async () => {
		let deliverChannel: ((channel: ExecChannel) => void) | undefined
		const requestChannel: RequestChannel = (_command, callback) => {
			deliverChannel = (channel) => callback(undefined, channel)
		}

		const resultPromise = execWithBoundedAcquisition(requestChannel, "echo hi", 1000)
		const assertion = expect(resultPromise).rejects.toThrow(/timed out waiting for a channel/i)
		await vi.advanceTimersByTimeAsync(1000)
		await assertion

		const lateChannel = createFakeExecChannel()
		deliverChannel?.(lateChannel.channel)

		expect(lateChannel.wasDestroyed()).toBe(true)
	})

	it("does not reject or destroy the channel again once the original timeout has since elapsed", async () => {
		const fake = createFakeExecChannel()
		const requestChannel: RequestChannel = (_command, callback) => callback(undefined, fake.channel)

		const resultPromise = execWithBoundedAcquisition(requestChannel, "echo hi", 1000)
		fake.emitStdout(Buffer.from("hi\n"))
		fake.emitClose(0)
		await expect(resultPromise).resolves.toEqual({ stdout: "hi\n", stderr: "", exitCode: 0 })

		await vi.advanceTimersByTimeAsync(5000)

		expect(fake.wasDestroyed()).toBe(false)
	})
})

describe("naming a refused channel", () => {
	it("says a refused channel is a limit, not an unreachable host", () => {
		const named = namedChannelError(new Error("(SSH) Channel open failure: open failed"), "ls")

		expect(named).toBeInstanceOf(ChannelLimitReachedError)
		expect(named.message).toContain("MaxSessions")
	})

	it("recognises the other ways a host refuses a channel", () => {
		for (const message of [
			"administratively prohibited",
			"resource shortage",
			"too many open channels",
		]) {
			expect(isChannelExhaustion(new Error(message))).toBe(true)
		}
	})

	it("leaves an unrelated failure exactly as it was", () => {
		const original = new Error("connection reset by peer")

		expect(namedChannelError(original, "ls")).toBe(original)
	})
})
