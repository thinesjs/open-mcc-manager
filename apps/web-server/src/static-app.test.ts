import { readFile } from "node:fs/promises"
import path from "node:path"
import { beforeAll, describe, expect, it } from "vitest"
import { createStaticApp } from "./static-app"
import { BUILD_TIMEOUT_MS, builtDashboard } from "./test/built-dashboard"

const EXPECTED_HEADERS = {
	"strict-transport-security": "max-age=63072000; includeSubDomains; preload",
	"content-security-policy":
		"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'",
	"x-content-type-options": "nosniff",
	"referrer-policy": "no-referrer",
	"permissions-policy": "camera=(), microphone=(), geolocation=(), interest-cohort=()",
	"cross-origin-opener-policy": "same-origin",
	"cross-origin-resource-policy": "same-origin",
	"x-frame-options": "DENY",
} as const

const RESERVED_FOR_THE_API = [
	"/healthz",
	"/api",
	"/api/auth/get-session",
	"/api/avatars/someone",
	"/trpc",
	"/trpc/host.list",
	"/%61pi/auth/get-session",
]

const NOT_THE_API = ["/apixyz", "/trpcfoo", "/healthzz", "/apis", "/trpcs"]

const CLIMBS_OUT = [
	{ climb: "/..%2fpackage.json", leaks: "@open-mcc/web" },
	{ climb: "/..%2findex.html", leaks: "/src/main.tsx" },
	{ climb: "/%2e%2e%2f%2e%2e%2f%2e%2e/apps/server/package.json", leaks: "@open-mcc/server" },
]

const MALFORMED = ["/%00", "/assets/index%00.js", "/%e0%a4%a1%zz"]

let root = ""
let shell = ""
let hashedAsset = ""

const dashboard = () => createStaticApp(root)

const headersOf = (response: Response) =>
	Object.fromEntries(
		Object.keys(EXPECTED_HEADERS).map((name) => [name, response.headers.get(name)]),
	)

beforeAll(async () => {
	const built = await builtDashboard()
	root = built.root
	shell = built.shell
	hashedAsset = built.hashedAsset
}, BUILD_TIMEOUT_MS)

describe("the dashboard image's server", () => {
	it("answers an address the router owns with the application shell", async () => {
		const response = await dashboard().request("/hosts")
		expect(response.status).toBe(200)
		expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8")
		expect(await response.text()).toBe(shell)
	})

	it("answers a nested address the router owns with the shell as well", async () => {
		const response = await dashboard().request("/instances/HnI2vNTGtCdbBQ8WRIlQL")
		expect(response.status).toBe(200)
		expect(await response.text()).toBe(shell)
	})

	it("answers the root with the shell", async () => {
		const response = await dashboard().request("/")
		expect(response.status).toBe(200)
		expect(await response.text()).toBe(shell)
	})

	it("answers a built asset with the file itself", async () => {
		const response = await dashboard().request(hashedAsset)
		expect(response.status).toBe(200)
		expect(response.headers.get("content-type")).toBe("text/javascript; charset=utf-8")
		expect(Buffer.from(await response.arrayBuffer())).toEqual(
			await readFile(path.join(root, hashedAsset)),
		)
	})

	it("answers an asset this build does not carry with a refusal, never with the shell", async () => {
		const response = await dashboard().request("/assets/index-not-in-this-build.js")
		expect(response.status).toBe(404)
		expect(await response.text()).not.toBe(shell)
	})

	it("answers a missing file outside the asset directory with a refusal too", async () => {
		const response = await dashboard().request("/logo-not-in-this-build.png")
		expect(response.status).toBe(404)
		expect(await response.text()).not.toBe(shell)
	})

	it("answers a request for the asset directory itself with a refusal", async () => {
		const response = await dashboard().request("/assets/")
		expect(response.status).toBe(404)
		expect(await response.text()).not.toBe(shell)
	})

	it("leaves every path the API owns unanswered", async () => {
		const answers = await Promise.all(
			RESERVED_FOR_THE_API.map(async (reserved) => {
				const response = await dashboard().request(reserved)
				return { reserved, status: response.status, isShell: (await response.text()) === shell }
			}),
		)
		expect(answers).toEqual(
			RESERVED_FOR_THE_API.map((reserved) => ({ reserved, status: 404, isShell: false })),
		)
	})

	it("caches a content-hashed asset for a year and never revalidates it", async () => {
		const response = await dashboard().request(hashedAsset)
		expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable")
	})

	it("lets nothing store the shell", async () => {
		const shellPaths = ["/", "/hosts", "/instances/HnI2vNTGtCdbBQ8WRIlQL"]
		const stored = await Promise.all(
			shellPaths.map(async (each) =>
				(await dashboard().request(each)).headers.get("cache-control"),
			),
		)
		expect(stored).toEqual(shellPaths.map(() => "no-store"))
	})

	it("lets nothing store a file that carries no hash in its name", async () => {
		const response = await dashboard().request("/logo.png")
		expect(response.status).toBe(200)
		expect(response.headers.get("cache-control")).toBe("no-store")
	})

	it("carries the dashboard's security headers on the shell", async () => {
		expect(headersOf(await dashboard().request("/hosts"))).toEqual(EXPECTED_HEADERS)
	})

	it("carries them on an asset", async () => {
		expect(headersOf(await dashboard().request(hashedAsset))).toEqual(EXPECTED_HEADERS)
	})

	it("carries them on a refusal", async () => {
		expect(headersOf(await dashboard().request("/trpc/host.list"))).toEqual(EXPECTED_HEADERS)
	})

	it("reaches nothing above the built dashboard when an encoded separator hides the climb", async () => {
		const answers = await Promise.all(
			CLIMBS_OUT.map(async ({ climb, leaks }) => {
				const response = await dashboard().request(climb)
				const body = await response.text()
				return { climb, status: response.status, leaked: body.includes(leaks) }
			}),
		)
		expect(answers).toEqual(CLIMBS_OUT.map(({ climb }) => ({ climb, status: 404, leaked: false })))
	})

	it("answers a climb the URL parser has already collapsed as the path it collapsed to", async () => {
		const response = await dashboard().request(`/%2e%2e${hashedAsset}`)
		expect(response.status).toBe(200)
		expect(Buffer.from(await response.arrayBuffer())).toEqual(
			await readFile(path.join(root, hashedAsset)),
		)
	})

	it("finds a file whose name reaches it percent-encoded", async () => {
		const response = await dashboard().request(hashedAsset.replaceAll("-", "%2D"))
		expect(response.status).toBe(200)
		expect(Buffer.from(await response.arrayBuffer())).toEqual(
			await readFile(path.join(root, hashedAsset)),
		)
	})

	it("refuses a path it cannot decode or that carries a null byte", async () => {
		const answers = await Promise.all(
			MALFORMED.map(async (malformed) => {
				const response = await dashboard().request(malformed)
				return {
					malformed,
					status: response.status,
					isShell: (await response.text()) === shell,
				}
			}),
		)
		expect(answers).toEqual(
			MALFORMED.map((malformed) => ({ malformed, status: 404, isShell: false })),
		)
	})

	it("treats an address that merely begins with an API prefix as a dashboard route", async () => {
		const answers = await Promise.all(
			NOT_THE_API.map(async (each) => {
				const response = await dashboard().request(each)
				return { each, status: response.status, isShell: (await response.text()) === shell }
			}),
		)
		expect(answers).toEqual(NOT_THE_API.map((each) => ({ each, status: 200, isShell: true })))
	})

	it("stores nothing when an asset-looking path resolves to the shell", async () => {
		const response = await dashboard().request("/assets/..%2findex.html")
		expect(response.status).toBe(200)
		expect(await response.text()).toBe(shell)
		expect(response.headers.get("cache-control")).toBe("no-store")
	})

	it("caches for a year when a path hiding the asset directory resolves into it", async () => {
		const response = await dashboard().request(hashedAsset.replace("/assets/", "/assets%2f"))
		expect(response.status).toBe(200)
		expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable")
	})

	it("does not answer a write to a dashboard address with the shell", async () => {
		const response = await dashboard().request("/hosts", { method: "POST" })
		expect(response.status).toBe(404)
		expect(await response.text()).not.toBe(shell)
	})
})
