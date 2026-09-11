import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { Hono } from "hono"
import { describe, expect, it } from "vitest"
import { applyRequestLimits, REQUEST_BODY_LIMIT_BYTES } from "./request-limits"

const here = dirname(fileURLToPath(import.meta.url))
const bootstrap = readFileSync(join(here, "bootstrap.ts"), "utf8")

const limited = () => {
	const app = new Hono()
	applyRequestLimits(app)
	app.post("/anything", async (c) => c.json({ read: (await c.req.text()).length }))
	return app
}

describe("how large a request the api will read", () => {
	it("accepts a body inside the limit and still hands it to the route", async () => {
		const response = await limited().request("/anything", {
			method: "POST",
			body: "x".repeat(1024),
		})

		expect(response.status).toBe(200)
		await expect(response.json()).resolves.toEqual({ read: 1024 })
	})

	it("refuses a body one byte over the limit", async () => {
		const response = await limited().request("/anything", {
			method: "POST",
			body: "x".repeat(REQUEST_BODY_LIMIT_BYTES + 1),
		})

		expect(response.status).toBe(413)
	})

	it("answers that refusal in the shape a browser client can read, not bare text", async () => {
		const response = await limited().request("/anything", {
			method: "POST",
			body: "x".repeat(REQUEST_BODY_LIMIT_BYTES + 1),
		})

		expect(response.headers.get("content-type")).toContain("application/json")
		await expect(response.json()).resolves.toEqual({ message: "That request was too large." })
	})

	it("leaves room for the largest config an operator can save", () => {
		expect(REQUEST_BODY_LIMIT_BYTES).toBeGreaterThan(64 * 1024)
		expect(REQUEST_BODY_LIMIT_BYTES).toBeLessThan(4 * 1024 * 1024)
	})
})

describe("where that bound sits in the running server", () => {
	it("is applied at all, through the one helper that owns it", () => {
		expect(bootstrap).toContain("applyRequestLimits(app)")
	})

	it.each([
		{ named: "the sign-in endpoints, which need no session at all", after: '"/api/auth/*"' },
		{ named: "the router every mutation arrives through", after: "trpcServer({" },
	])("is applied before $named", ({ after }) => {
		expect(bootstrap.indexOf("applyRequestLimits(app)")).toBeLessThan(bootstrap.indexOf(after))
	})
})
