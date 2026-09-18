import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { routeTree } from "~/routeTree.gen"

type SocialSignIn = { provider: string; callbackURL: string; errorCallbackURL: string }

const getSession = vi.fn()
const signInSocial = vi.fn()
const signInOptions = vi.fn()

vi.mock("~/lib/auth-client", () => ({
	authClient: {
		getSession: () => getSession(),
		signIn: { social: (input: SocialSignIn) => signInSocial(input) },
	},
}))

vi.mock("~/lib/trpc", () => ({
	trpcClient: { system: { signInOptions: { query: () => signInOptions() } } },
	queryClient: {},
	useTRPC: () => ({}),
	useTRPCClient: () => ({}),
	TRPCProvider: () => null,
}))

afterEach(() => {
	cleanup()
	for (const mock of [getSession, signInSocial, signInOptions]) mock.mockReset()
	signInOptions.mockResolvedValue({ singleSignOn: null })
})

signInOptions.mockResolvedValue({ singleSignOn: null })

const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "sign-in.tsx"), "utf8")

const routerFor = (href: string) =>
	createRouter({ routeTree, history: createMemoryHistory({ initialEntries: [href] }) })

const landingFor = async (href: string): Promise<string> => {
	const router = routerFor(href)
	await router.load()
	return router.state.location.pathname
}

const open = async (href: string) => {
	const router = routerFor(href)
	await router.load()
	render(<RouterProvider router={router} />)
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

describe("signing in through a provider the operator configured", () => {
	it("offers only the password form when this deployment has no provider", async () => {
		getSession.mockResolvedValue({ data: null })
		await open("/sign-in")

		expect(await screen.findByRole("button", { name: "Sign in" })).toBeDefined()
		expect(screen.queryByText("or")).toBeNull()
		expect(screen.queryByRole("button", { name: /Continue with/ })).toBeNull()
	})

	it("puts the name the operator configured on the button, and no provider jargon", async () => {
		getSession.mockResolvedValue({ data: null })
		signInOptions.mockResolvedValue({ singleSignOn: { name: "Acme ID" } })
		await open("/sign-in")

		expect(await screen.findByRole("button", { name: "Continue with Acme ID" })).toBeDefined()
		expect(screen.queryByText(/OIDC|OpenID|SSO|OAuth/)).toBeNull()
	})

	it("still offers a button when the operator named no provider, so the page is never a dead end", async () => {
		getSession.mockResolvedValue({ data: null })
		signInOptions.mockResolvedValue({ singleSignOn: { name: "single sign-on" } })
		await open("/sign-in")

		expect(
			await screen.findByRole("button", { name: "Continue with single sign-on" }),
		).toBeDefined()
	})

	it("asks for both landings back on the dashboard's own origin", async () => {
		getSession.mockResolvedValue({ data: null })
		signInOptions.mockResolvedValue({ singleSignOn: { name: "Acme ID" } })
		signInSocial.mockResolvedValue({ error: null })
		await open("/sign-in")

		fireEvent.click(await screen.findByRole("button", { name: "Continue with Acme ID" }))

		await waitFor(() => expect(signInSocial).toHaveBeenCalledTimes(1))
		expect(signInSocial).toHaveBeenCalledWith({
			provider: "oidc",
			callbackURL: `${window.location.origin}/hosts`,
			errorCallbackURL: `${window.location.origin}/sign-in`,
		})
	})

	it("tells a stranger the gate turned away that registration is closed", async () => {
		getSession.mockResolvedValue({ data: null })
		signInOptions.mockResolvedValue({ singleSignOn: { name: "Acme ID" } })
		await open("/sign-in?error=registration_closed")

		expect(
			await screen.findByText("Registration is closed. New members join by invitation."),
		).toBeDefined()
	})

	it("tells a member whose provider vouched for nothing why they were not matched", async () => {
		getSession.mockResolvedValue({ data: null })
		signInOptions.mockResolvedValue({ singleSignOn: { name: "Acme ID" } })
		await open("/sign-in?error=account_not_linked")

		expect(
			await screen.findByText(
				"Your provider did not confirm this email address, so it was not matched to a member here.",
			),
		).toBeDefined()
	})

	it("says nothing broke when the round trip simply did not finish", async () => {
		getSession.mockResolvedValue({ data: null })
		signInOptions.mockResolvedValue({ singleSignOn: { name: "Acme ID" } })
		await open("/sign-in?error=invalid_code")

		expect(
			await screen.findByText(
				"That sign-in did not finish. Try again, or sign in with your email and password.",
			),
		).toBeDefined()
		expect(screen.queryByText(/Internal server error/i)).toBeNull()
	})

	it("reads no sentence a stranger put in the link back to the visitor", async () => {
		getSession.mockResolvedValue({ data: null })
		signInOptions.mockResolvedValue({ singleSignOn: { name: "Acme ID" } })
		await open("/sign-in?error=Your+account+is+suspended.+Call+555-0100.")

		expect(screen.queryByText(/555-0100/)).toBeNull()
		expect(
			await screen.findByText(
				"That sign-in did not finish. Try again, or sign in with your email and password.",
			),
		).toBeDefined()
	})

	it.each(["toString", "constructor", "__proto__", "valueOf", "hasOwnProperty"])(
		"still renders the form when the link names %s, which is on every object but in no table",
		async (forged) => {
			getSession.mockResolvedValue({ data: null })
			signInOptions.mockResolvedValue({ singleSignOn: { name: "Acme ID" } })
			await open(`/sign-in?error=${forged}`)

			expect(await screen.findByRole("button", { name: "Sign in" })).toBeDefined()
			expect(
				screen.getByText(
					"That sign-in did not finish. Try again, or sign in with your email and password.",
				),
			).toBeDefined()
			expect(screen.queryByText(/object|Objects are not valid/)).toBeNull()
		},
	)
})

describe("a deployment that configured no provider", () => {
	it.each([
		"registration_closed",
		"account_not_linked",
		"email_not_found",
		"invalid_code",
		"toString",
		"constructor",
		"__proto__",
	])("says nothing at all about a provider when the link carries %s", async (forged) => {
		getSession.mockResolvedValue({ data: null })
		await open(`/sign-in?error=${forged}`)

		expect(await screen.findByRole("button", { name: "Sign in" })).toBeDefined()
		expect(screen.queryByRole("alert")).toBeNull()
		expect(screen.queryByText(/provider|Registration is closed|sign-in did not finish/)).toBeNull()
	})

	it("leaves a query string it does not own exactly where the visitor found it", async () => {
		getSession.mockResolvedValue({ data: null })
		const router = routerFor("/sign-in?foo=bar")
		await router.load()

		expect(router.state.location.searchStr).toBe("?foo=bar")
	})
})
