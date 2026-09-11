import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { Hono } from "hono"
import { bodyLimit } from "hono/body-limit"
import { describe, expect, it } from "vitest"
import { REQUEST_BODY_LIMIT_BYTES } from "./bootstrap"

const here = dirname(fileURLToPath(import.meta.url))
const bootstrap = readFileSync(join(here, "bootstrap.ts"), "utf8")

describe("how large a request the api will read", () => {
	it("bounds every route, not only the one this manager happens to own", () => {
		expect(bootstrap).toContain("bodyLimit({")
		expect(bootstrap).not.toContain('"/trpc/*", bodyLimit')
	})

	it.each([
		{ named: "the sign-in endpoints, which need no session at all", after: '"/api/auth/*"' },
		{ named: "the router every mutation arrives through", after: "trpcServer({" },
	])("applies that bound before $named", ({ after }) => {
		expect(bootstrap.indexOf("bodyLimit({")).toBeLessThan(bootstrap.indexOf(after))
	})

	it("answers in the shape a browser client can read, not bare text", async () => {
		const app = new Hono()
		app.use("*", bodyLimit({ maxSize: 16, onError: (c) => c.json({ message: "too big" }, 413) }))
		app.post("/", (c) => c.json({ ok: true }))
		const over = await app.request("/", { method: "POST", body: "x".repeat(64) })

		expect(over.headers.get("content-type")).toContain("application/json")
		await expect(over.json()).resolves.toEqual({ message: "too big" })
	})

	it("leaves room for the largest config an operator can save", () => {
		expect(REQUEST_BODY_LIMIT_BYTES).toBeGreaterThan(64 * 1024)
		expect(REQUEST_BODY_LIMIT_BYTES).toBeLessThan(4 * 1024 * 1024)
	})

	it("refuses a body over that bound and accepts one under it", async () => {
		const app = new Hono()
		app.use("*", bodyLimit({ maxSize: REQUEST_BODY_LIMIT_BYTES }))
		app.post("/", async (c) => c.json({ read: (await c.req.text()).length }))

		const under = await app.request("/", { method: "POST", body: "x".repeat(1024) })
		const over = await app.request("/", {
			method: "POST",
			body: "x".repeat(REQUEST_BODY_LIMIT_BYTES + 1),
		})

		expect(under.status).toBe(200)
		expect(over.status).toBe(413)
	})
})
