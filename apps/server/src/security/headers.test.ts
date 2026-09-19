import { Hono } from "hono"
import { describe, expect, it } from "vitest"
import { securityHeaders } from "./headers"

const app = new Hono()
app.use("*", securityHeaders())
app.get("/x", (c) => c.text("ok"))

describe("securityHeaders", () => {
	it("sets HSTS for two years with subdomains and preload", async () => {
		const res = await app.request("/x")
		expect(res.headers.get("strict-transport-security")).toBe(
			"max-age=63072000; includeSubDomains; preload",
		)
	})

	it("sets a CSP that forbids framing and inline script", async () => {
		const csp = (await app.request("/x")).headers.get("content-security-policy") ?? ""
		expect(csp).toContain("frame-ancestors 'none'")
		expect(csp).toContain("object-src 'none'")
		expect(csp).not.toContain("unsafe-inline")
	})

	it("sets the remaining hardening headers", async () => {
		const res = await app.request("/x")
		expect(res.headers.get("x-content-type-options")).toBe("nosniff")
		expect(res.headers.get("referrer-policy")).toBe("no-referrer")
		expect(res.headers.get("x-frame-options")).toBe("DENY")
		expect(res.headers.get("cross-origin-opener-policy")).toBe("same-origin")
		expect(res.headers.get("cross-origin-resource-policy")).toBe("same-origin")
	})

	it("removes any server fingerprinting header", async () => {
		const res = await app.request("/x")
		expect(res.headers.get("x-powered-by")).toBeNull()
	})
})
