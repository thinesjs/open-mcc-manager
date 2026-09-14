import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { createMemoryHistory, createRouter } from "@tanstack/react-router"
import { afterEach, describe, expect, it, vi } from "vitest"
import { routeTree } from "~/routeTree.gen"

const getSession = vi.fn()

vi.mock("~/lib/auth-client", () => ({
	authClient: { getSession: () => getSession() },
}))

afterEach(() => {
	getSession.mockReset()
})

const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "sign-in.tsx"), "utf8")

const landingFor = async (href: string): Promise<string> => {
	const router = createRouter({
		routeTree,
		history: createMemoryHistory({ initialEntries: [href] }),
	})
	await router.load()
	return router.state.location.pathname
}

describe("opening sign in", () => {
	it("sends a signed-in visitor on to where signing in lands", async () => {
		getSession.mockResolvedValue({ data: { session: { id: "s1" } } })
		expect(await landingFor("/sign-in")).toBe("/hosts")
	})

	it("shows sign in to a signed-out visitor", async () => {
		getSession.mockResolvedValue({ data: null })
		expect(await landingFor("/sign-in")).toBe("/sign-in")
	})

	it("agrees with the dashboard when the session check fails, so neither bounces to the other", async () => {
		getSession.mockResolvedValue({ error: { status: 500 } })
		expect(await landingFor("/sign-in")).toBe("/hosts")
		expect(await landingFor("/hosts")).toBe("/hosts")
	})

	it("names that place once, for both a fresh sign-in and a visitor already signed in", () => {
		expect(source).toContain("navigate({ to: SIGNED_IN_LANDING })")
		expect(source).toContain("redirect({ to: SIGNED_IN_LANDING })")
		expect(source).not.toContain('"/hosts"')
	})
})
