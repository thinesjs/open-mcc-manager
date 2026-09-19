import { createLogger, generateKeyPair, type Logger } from "@open-mcc/core"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Env } from "./env"
import { SELF_HOST_UNUSABLE_WARNING } from "./self-host-env"

type OnError = (message: string, error: Error | string) => void

const captured: {
	onLost: (() => void) | undefined
	schedulerError: OnError | undefined
	pollerError: OnError | undefined
} = { onLost: undefined, schedulerError: undefined, pollerError: undefined }

vi.mock("./singleton", () => ({
	acquireSingletonLock: async () => ({
		acquired: true,
		onLost: (handler: () => void) => {
			captured.onLost = handler
		},
		release: async () => undefined,
	}),
}))

vi.mock("@open-mcc/core", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@open-mcc/core")>()
	return {
		...actual,
		startScheduler: (deps: { onError: OnError }) => {
			captured.schedulerError = deps.onError
			return { stop: () => undefined }
		},
		startHealthPoller: (deps: { onError: OnError }) => {
			captured.pollerError = deps.onError
			return { stop: () => undefined }
		},
	}
})

const capturing = (): { lines: string[]; logger: Logger } => {
	const lines: string[] = []
	return { lines, logger: createLogger({ level: "debug", write: (line) => lines.push(line) }) }
}

const env = async (): Promise<Env> => ({
	DATABASE_URL: process.env.TEST_DATABASE_URL ?? "",
	PORT: 0,
	STATUS_RETENTION_DAYS: 30,
	BETTER_AUTH_SECRET: "a-very-long-test-secret-value-000000",
	BETTER_AUTH_URL: "http://localhost:3000",
	SEALBOX_KEYS: await generateKeyPair("k1"),
	ALLOWED_ORIGINS: "http://localhost:5173",
	NOTIFICATION_ALLOW_HTTP: false,
	NOTIFICATION_ALLOWED_HOSTS: "",
	NOTIFICATION_ALLOWED_ADDRESSES: "",
	NOTIFICATION_TEAMS_HOSTS: "",
	OTEL_EXPORTER_OTLP_ENDPOINT: "",
})

const startWithCapture = async () => {
	const { startServer } = await import("./bootstrap")
	const { lines, logger } = capturing()
	const closed = vi.fn()
	const serveFn = vi.fn()
	serveFn.mockReturnValue({ close: closed })
	const handle = await startServer(await env(), serveFn, logger)
	return { lines, handle, closed }
}

let stop: (() => Promise<void>) | undefined

beforeEach(() => {
	captured.onLost = undefined
	captured.schedulerError = undefined
	captured.pollerError = undefined
})

afterEach(async () => {
	if (stop) await stop()
	stop = undefined
	vi.restoreAllMocks()
})

describe("the reporters the server actually hands to the things it starts", () => {
	it("wires the lock-loss handler, so losing the lock is announced before the exit", async () => {
		const exited = vi.spyOn(process, "exit").mockImplementation(() => {
			throw new Error("process.exit called")
		})
		const { lines, handle, closed } = await startWithCapture()
		stop = async () => {
			await handle.boss.stop({ graceful: false })
			await handle.db.destroy()
		}

		expect(captured.onLost).toBeDefined()
		lines.length = 0

		expect(() => captured.onLost?.()).toThrow("process.exit called")

		expect(JSON.parse(lines[0] ?? "{}").message).toBe("Singleton lock lost; quiescing and exiting")
		expect(closed).toHaveBeenCalled()
		expect(exited).toHaveBeenCalledWith(1)
	})

	it("wires the scheduler's error reporter, independently of the health poller's", async () => {
		const { lines, handle } = await startWithCapture()
		stop = async () => {
			await handle.boss.stop({ graceful: false })
			await handle.db.destroy()
		}

		lines.length = 0
		captured.schedulerError?.("Scheduled command failed", "the host refused")

		const entry = JSON.parse(lines[0] ?? "{}")
		expect(entry.level).toBe("error")
		expect(entry.detail).toBe("the host refused")
	})

	it("wires the health poller's error reporter, independently of the scheduler's", async () => {
		const { lines, handle } = await startWithCapture()
		stop = async () => {
			await handle.boss.stop({ graceful: false })
			await handle.db.destroy()
		}

		lines.length = 0
		captured.pollerError?.("Health poll failed", "the host refused")

		const entry = JSON.parse(lines[0] ?? "{}")
		expect(entry.level).toBe("error")
		expect(entry.detail).toBe("the host refused")
	})
})

const INSTALLED_SELF_HOST: Partial<Env> = {
	SELF_HOST_NAME: "kitchen-pi",
	SELF_HOST_HOSTNAME: "host.docker.internal",
	SELF_HOST_PORT: "22",
	SELF_HOST_USERNAME: "mcc",
	SELF_HOST_FINGERPRINT: "SHA256:5t0oGkKIrpBGw7Z4LrnOdxM6wJzJPuK+aQ8N9sVhP1c",
	SELF_HOST_PUBLIC_KEY: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA open-mcc:this-machine",
	SELF_HOST_PRIVATE_KEY_SEALED: "Xj+9/abcDEF==ghi+/jkl",
	SELF_HOST_PRIVATE_KEY_ID: "k1",
	SELF_HOST_REACH: "proven",
	SELF_HOST_SYSTEMD: "yes",
	SELF_HOST_LINGER: "yes",
}

const messagesAtStartup = async (overrides: Partial<Env>): Promise<string[]> => {
	const { startServer } = await import("./bootstrap")
	const { lines, logger } = capturing()
	const serveFn = vi.fn()
	serveFn.mockReturnValue({ close: vi.fn() })
	const handle = await startServer({ ...(await env()), ...overrides }, serveFn, logger)
	stop = async () => {
		await handle.boss.stop({ graceful: false })
		await handle.db.destroy()
	}
	return lines.map((line) => JSON.parse(line).message)
}

describe("what the server says about the machine it was installed on", () => {
	it("warns when the installer's materials are there but unusable, or the card would silently never appear", async () => {
		const messages = await messagesAtStartup({
			...INSTALLED_SELF_HOST,
			SELF_HOST_PRIVATE_KEY_SEALED: "",
		})

		expect(messages).toContain(SELF_HOST_UNUSABLE_WARNING)
	})

	it("stays quiet when the materials describe a machine it can offer", async () => {
		const messages = await messagesAtStartup(INSTALLED_SELF_HOST)

		expect(messages).not.toContain(SELF_HOST_UNUSABLE_WARNING)
	})

	it("stays quiet on an install that never offered a machine", async () => {
		const messages = await messagesAtStartup({})

		expect(messages).not.toContain(SELF_HOST_UNUSABLE_WARNING)
	})
})
