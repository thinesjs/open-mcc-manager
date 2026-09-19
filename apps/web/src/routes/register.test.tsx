import type { RegisterFirstOwnerInput } from "@open-mcc/contracts"
import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { routeTree } from "~/routeTree.gen"

type Credentials = { email: string; password: string }

const getSession = vi.fn()
const signInEmail = vi.fn()
const signInOptions = vi.fn()
const registerFirstOwner = vi.fn()

vi.mock("~/lib/auth-client", () => ({
	authClient: {
		getSession: () => getSession(),
		signIn: { email: (input: Credentials) => signInEmail(input) },
	},
}))

vi.mock("~/lib/trpc", () => ({
	trpcClient: {
		system: { signInOptions: { query: () => signInOptions() } },
		member: {
			registerFirstOwner: { mutate: (input: RegisterFirstOwnerInput) => registerFirstOwner(input) },
		},
	},
	queryClient: {},
	useTRPC: () => ({}),
	useTRPCClient: () => ({}),
	TRPCProvider: () => null,
}))

const OPEN = { singleSignOn: null, registrationOpen: true }
const CLOSED = { singleSignOn: null, registrationOpen: false }

afterEach(() => {
	cleanup()
	for (const mock of [getSession, signInEmail, signInOptions, registerFirstOwner]) mock.mockReset()
	getSession.mockResolvedValue({ data: null })
	signInOptions.mockResolvedValue(CLOSED)
})

getSession.mockResolvedValue({ data: null })
signInOptions.mockResolvedValue(CLOSED)

const routerFor = (href: string) =>
	createRouter({ routeTree, history: createMemoryHistory({ initialEntries: [href] }) })

const open = async (href: string) => {
	const router = routerFor(href)
	await router.load()
	render(<RouterProvider router={router} />)
	return router
}

const fill = (label: string, value: string) => {
	fireEvent.change(screen.getByLabelText(label), { target: { value } })
}

const fillTheForm = () => {
	fill("Name", "Cave Johnson")
	fill("Organization", "Aperture Science")
	fill("Email", "cave@example.com")
	fill("Password", "correct horse battery staple")
	fill("Confirm password", "correct horse battery staple")
}

describe("the register page while this deployment has no account", () => {
	it("asks for the account and the organization it will own", async () => {
		signInOptions.mockResolvedValue(OPEN)
		await open("/register")

		expect(await screen.findByRole("button", { name: "Create account" })).toBeDefined()
		for (const label of ["Name", "Organization", "Email", "Password", "Confirm password"]) {
			expect(screen.getByLabelText(label)).toBeDefined()
		}
	})

	it("sends what was typed to the server and signs the new owner straight in", async () => {
		signInOptions.mockResolvedValue(OPEN)
		registerFirstOwner.mockResolvedValue({ registered: true })
		signInEmail.mockImplementation(async () => {
			getSession.mockResolvedValue({ data: { session: { id: "s1" } } })
			return { error: null }
		})
		const router = await open("/register")

		fillTheForm()
		fireEvent.click(screen.getByRole("button", { name: "Create account" }))

		await waitFor(() => expect(registerFirstOwner).toHaveBeenCalledTimes(1))
		expect(registerFirstOwner).toHaveBeenCalledWith({
			email: "cave@example.com",
			password: "correct horse battery staple",
			name: "Cave Johnson",
			organizationName: "Aperture Science",
		})
		await waitFor(() => expect(router.state.location.pathname).toBe("/hosts"))
	})

	it("creates nothing when the two passwords differ", async () => {
		signInOptions.mockResolvedValue(OPEN)
		await open("/register")

		fillTheForm()
		fill("Confirm password", "correct horse battery stapl")
		fireEvent.click(screen.getByRole("button", { name: "Create account" }))

		expect(await screen.findByText("Passwords do not match.")).toBeDefined()
		expect(registerFirstOwner).not.toHaveBeenCalled()
	})

	it("shows the server's refusal rather than a blank page when registration closed underneath", async () => {
		signInOptions.mockResolvedValue(OPEN)
		registerFirstOwner.mockRejectedValue(
			Object.assign(new Error("Registration is closed. New members join by invitation."), {
				data: { errorCode: "REGISTRATION_CLOSED", httpStatus: 403 },
			}),
		)
		await open("/register")

		fillTheForm()
		fireEvent.click(screen.getByRole("button", { name: "Create account" }))

		expect(
			await screen.findByText("Registration is closed. New members join by invitation."),
		).toBeDefined()
		expect(signInEmail).not.toHaveBeenCalled()
	})
})

describe("the register page once an account exists", () => {
	it("says registration is closed and offers no form", async () => {
		await open("/register")

		expect(
			await screen.findByText("Registration is closed. New members join by invitation."),
		).toBeDefined()
		expect(screen.queryByRole("button", { name: "Create account" })).toBeNull()
		expect(screen.queryByLabelText("Email")).toBeNull()
	})

	it("sends an operator who bookmarked it to the only way in that is left", async () => {
		await open("/register")

		const link = await screen.findByRole("link", { name: "Go to sign in" })
		expect(link.getAttribute("href")).toBe("/sign-in")
	})

	it("sends a visitor who is already signed in on to the dashboard", async () => {
		getSession.mockResolvedValue({ data: { session: { id: "s1" } } })
		const router = routerFor("/register")
		await router.load()

		expect(router.state.location.pathname).toBe("/hosts")
	})
})

describe("the sign-in page's way to the register page", () => {
	it("offers it while this deployment has no account", async () => {
		signInOptions.mockResolvedValue(OPEN)
		await open("/sign-in")

		const link = await screen.findByRole("link", { name: "Create the first one" })
		expect(link.getAttribute("href")).toBe("/register")
	})

	it("offers it no more once an account exists", async () => {
		await open("/sign-in")

		expect(await screen.findByRole("button", { name: "Sign in" })).toBeDefined()
		expect(screen.queryByRole("link", { name: "Create the first one" })).toBeNull()
		expect(screen.queryByText(/No account exists yet/)).toBeNull()
	})
})
