import { Hono } from "hono"
import { describe, expect, it } from "vitest"
import { requireSameOrigin, strictCors } from "./cors"

const allowed = ["https://app.example.com"]
const app = new Hono()
app.use("*", strictCors(allowed))
app.use("*", requireSameOrigin(allowed))
app.get("/x", (c) => c.text("ok"))
app.post("/x", (c) => c.text("ok"))

describe("strictCors", () => {
	it("echoes an allowed origin with credentials", async () => {
		const res = await app.request("/x", { headers: { Origin: allowed[0] ?? "" } })
		expect(res.headers.get("access-control-allow-origin")).toBe(allowed[0])
		expect(res.headers.get("access-control-allow-credentials")).toBe("true")
	})

	it("sends no CORS headers at all for an unlisted origin", async () => {
		const res = await app.request("/x", { headers: { Origin: "https://evil.example" } })
		expect(res.headers.get("access-control-allow-origin")).toBeNull()
		expect(res.headers.get("access-control-allow-credentials")).toBeNull()
	})

	it("never emits a wildcard", async () => {
		const res = await app.request("/x", { headers: { Origin: allowed[0] ?? "" } })
		expect(res.headers.get("access-control-allow-origin")).not.toBe("*")
	})
})

describe("requireSameOrigin", () => {
	it("rejects a mutation from a foreign origin", async () => {
		const res = await app.request("/x", {
			method: "POST",
			headers: { Origin: "https://evil.example" },
		})
		expect(res.status).toBe(403)
	})

	it("rejects a mutation with no origin header", async () => {
		const res = await app.request("/x", { method: "POST" })
		expect(res.status).toBe(403)
	})

	it("allows a safe method with no origin", async () => {
		expect((await app.request("/x")).status).toBe(200)
	})
})
