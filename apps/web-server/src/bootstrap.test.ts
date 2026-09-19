import { serve } from "@hono/node-server"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { portFrom, startWebServer } from "./bootstrap"
import { BUILD_TIMEOUT_MS, builtDashboard } from "./test/built-dashboard"

let origin = ""
let shell = ""
let hashedAsset = ""
let stop = async (): Promise<void> => {}

beforeAll(async () => {
	const built = await builtDashboard()
	shell = built.shell
	hashedAsset = built.hashedAsset
	const listening = await new Promise<{ server: ReturnType<typeof serve>; port: number }>(
		(resolve) => {
			const server = startWebServer({
				root: built.root,
				port: 0,
				serveFn: serve,
				onListen: (info) => resolve({ server, port: info.port }),
			})
		},
	)
	origin = `http://127.0.0.1:${listening.port}`
	stop = async () => await new Promise<void>((resolve) => listening.server.close(() => resolve()))
}, BUILD_TIMEOUT_MS)

afterAll(async () => {
	await stop()
})

describe("the dashboard image over a real socket", () => {
	it("answers an address the router owns with the application shell", async () => {
		const response = await fetch(`${origin}/hosts`)
		expect(response.status).toBe(200)
		expect(response.headers.get("cache-control")).toBe("no-store")
		expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'")
		expect(await response.text()).toBe(shell)
	})

	it("answers a built asset with the year-long cache rule", async () => {
		const response = await fetch(`${origin}${hashedAsset}`)
		expect(response.status).toBe(200)
		expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable")
	})

	it("answers an asset this build does not carry with a refusal, never with the shell", async () => {
		const response = await fetch(`${origin}/assets/index-not-in-this-build.js`)
		expect(response.status).toBe(404)
		expect(await response.text()).not.toBe(shell)
	})

	it("answers a HEAD for a dashboard address with the shell's headers and no body", async () => {
		const response = await fetch(`${origin}/hosts`, { method: "HEAD" })
		expect(response.status).toBe(200)
		expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8")
		expect(await response.text()).toBe("")
	})
})

describe("the port the dashboard listens on", () => {
	it("is 3000 when an operator set none", () => {
		expect(portFrom(undefined)).toBe(3000)
		expect(portFrom("")).toBe(3000)
	})

	it("is the one an operator set", () => {
		expect(portFrom("8080")).toBe(8080)
	})

	it("stops the dashboard starting when it is not a port number", () => {
		expect(() => portFrom("http://localhost:3000")).toThrow(
			"PORT must be a port number between 1 and 65535, not http://localhost:3000",
		)
		expect(() => portFrom("0")).toThrow("not 0")
		expect(() => portFrom("70000")).toThrow("not 70000")
		expect(() => portFrom("3000.5")).toThrow("not 3000.5")
	})
})
