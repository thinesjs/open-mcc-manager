import { describe, expect, it } from "vitest"
import {
	DIAGNOSTIC_TAIL_BYTES,
	type ExecChannel,
	execViaChannel,
	MAX_STDERR_BYTES,
	MAX_STDOUT_BYTES,
	StreamOverflowError,
} from "./exec"

type FakeChannel = {
	channel: ExecChannel
	emitStdout: (chunk: Buffer) => void
	emitStderr: (chunk: Buffer) => void
	emitClose: (exitCode: number | undefined) => void
	wasDestroyed: () => boolean
}

const createFakeChannel = (): FakeChannel => {
	let onStdout: ((chunk: Buffer) => void) | undefined
	let onStderr: ((chunk: Buffer) => void) | undefined
	let onClose: ((exitCode: number | undefined) => void) | undefined
	let destroyed = false

	return {
		channel: {
			onStdout: (listener) => {
				onStdout = listener
			},
			onStderr: (listener) => {
				onStderr = listener
			},
			onClose: (listener) => {
				onClose = listener
			},
			destroy: () => {
				destroyed = true
			},
		},
		emitStdout: (chunk) => onStdout?.(chunk),
		emitStderr: (chunk) => onStderr?.(chunk),
		emitClose: (exitCode) => onClose?.(exitCode),
		wasDestroyed: () => destroyed,
	}
}

describe("execViaChannel", () => {
	it("resolves with accumulated output when under the ceiling", async () => {
		const fake = createFakeChannel()
		const resultPromise = execViaChannel(fake.channel, "echo hi", 1000)
		fake.emitStdout(Buffer.from("hi\n"))
		fake.emitClose(0)
		await expect(resultPromise).resolves.toEqual({ stdout: "hi\n", stderr: "", exitCode: 0 })
		expect(fake.wasDestroyed()).toBe(false)
	})

	it("rejects and destroys the channel when stdout exceeds its ceiling, naming the stream", async () => {
		const fake = createFakeChannel()
		const resultPromise = execViaChannel(fake.channel, "flood", 1000)
		fake.emitStdout(Buffer.alloc(MAX_STDOUT_BYTES + 1, "a"))

		await expect(resultPromise).rejects.toBeInstanceOf(StreamOverflowError)
		await resultPromise.catch((error: StreamOverflowError) => {
			expect(error.stream).toBe("stdout")
			expect(error.message).toMatch(/stdout/i)
			expect(error.diagnostic.length).toBeLessThanOrEqual(DIAGNOSTIC_TAIL_BYTES)
		})
		expect(fake.wasDestroyed()).toBe(true)
	})

	it("rejects and destroys the channel when stderr exceeds its ceiling, naming the stream", async () => {
		const fake = createFakeChannel()
		const resultPromise = execViaChannel(fake.channel, "flood", 1000)
		fake.emitStderr(Buffer.alloc(MAX_STDERR_BYTES + 1, "b"))

		await expect(resultPromise).rejects.toBeInstanceOf(StreamOverflowError)
		await resultPromise.catch((error: StreamOverflowError) => {
			expect(error.stream).toBe("stderr")
			expect(error.message).toMatch(/stderr/i)
			expect(error.diagnostic.length).toBeLessThanOrEqual(DIAGNOSTIC_TAIL_BYTES)
		})
		expect(fake.wasDestroyed()).toBe(true)
	})

	it("rejects once and ignores a close that arrives after the overflow", async () => {
		const fake = createFakeChannel()
		const resultPromise = execViaChannel(fake.channel, "flood", 1000)
		fake.emitStdout(Buffer.alloc(MAX_STDOUT_BYTES + 1))
		fake.emitClose(0)
		await expect(resultPromise).rejects.toBeInstanceOf(StreamOverflowError)
	})

	it("accumulates chunks that individually stay under the ceiling but rejects once their sum overflows it", async () => {
		const fake = createFakeChannel()
		const resultPromise = execViaChannel(fake.channel, "flood", 1000)
		const half = Buffer.alloc(Math.ceil(MAX_STDOUT_BYTES / 2) + 1)
		fake.emitStdout(half)
		fake.emitStdout(half)

		await expect(resultPromise).rejects.toBeInstanceOf(StreamOverflowError)
		expect(fake.wasDestroyed()).toBe(true)
	})

	it("rejects and destroys the channel when the command exceeds its timeout", async () => {
		const fake = createFakeChannel()
		const resultPromise = execViaChannel(fake.channel, "sleep 999", 10)
		await expect(resultPromise).rejects.toThrow(/timed out/i)
		expect(fake.wasDestroyed()).toBe(true)
	})
})
