import type { AcceptInvitationInput } from "@open-mcc/contracts"
import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { routeTree } from "~/routeTree.gen"

const getSession = vi.fn()
const signOut = vi.fn()
const acceptInvitation = vi.fn()

vi.mock("~/lib/auth-client", () => ({
	authClient: { getSession: () => getSession(), signOut: () => signOut() },
}))

vi.mock("~/lib/trpc", () => ({
	trpcClient: {
		member: {
			acceptInvitation: { mutate: (input: AcceptInvitationInput) => acceptInvitation(input) },
		},
	},
}))

afterEach(() => {
	cleanup()
	for (const mock of [getSession, signOut, acceptInvitation]) mock.mockReset()
})

const SIGNED_IN = { data: { user: { email: "owner@example.com" }, session: { id: "s1" } } }
const SIGNED_OUT = { data: null }

const open = async (href: string) => {
	const router = createRouter({
		routeTree,
		history: createMemoryHistory({ initialEntries: [href] }),
	})
	await router.load()
	render(<RouterProvider router={router} />)
	return router
}

describe("opening an invitation while signed in", () => {
	it("says who is signed in and asks them to sign out, instead of offering a form", async () => {
		getSession.mockResolvedValue(SIGNED_IN)
		await open("/accept-invitation?invitation=inv-1")

		expect(
			await screen.findByText(
				"You're signed in as owner@example.com. Sign out to accept this invitation.",
			),
		).toBeDefined()
		expect(screen.queryByRole("button", { name: "Create account" })).toBeNull()
	})

	it("signs out and stays on the same invitation link, which then offers the form", async () => {
		getSession.mockResolvedValue(SIGNED_IN)
		signOut.mockImplementation(async () => {
			getSession.mockResolvedValue(SIGNED_OUT)
			return { data: { success: true } }
		})
		const router = await open("/accept-invitation?invitation=inv-1")

		fireEvent.click(await screen.findByRole("button", { name: "Sign out" }))

		expect(await screen.findByRole("button", { name: "Create account" })).toBeDefined()
		expect(signOut).toHaveBeenCalledTimes(1)
		expect(router.state.location.pathname).toBe("/accept-invitation")
		expect(router.state.location.search).toEqual({ invitation: "inv-1" })
	})
})

describe("opening an incomplete invitation link", () => {
	it.each([
		"/accept-invitation",
		"/accept-invitation?invitation=",
	])("says %s is incomplete rather than offering a form that can only fail", async (href) => {
		getSession.mockResolvedValue(SIGNED_OUT)
		await open(href)

		expect(await screen.findByText("This invitation link is incomplete.")).toBeDefined()
		expect(screen.queryByRole("button", { name: "Create account" })).toBeNull()
	})
})

describe("accepting an invitation while signed out", () => {
	it("creates the account for the invitation named in the link", async () => {
		getSession.mockResolvedValue(SIGNED_OUT)
		acceptInvitation.mockResolvedValue({ accepted: true })
		await open("/accept-invitation?invitation=inv-1")

		fireEvent.change(await screen.findByLabelText("Name"), { target: { value: "Ada" } })
		fireEvent.change(screen.getByLabelText("Password"), { target: { value: "long enough 1" } })
		fireEvent.change(screen.getByLabelText("Confirm password"), {
			target: { value: "long enough 1" },
		})
		fireEvent.click(screen.getByRole("button", { name: "Create account" }))

		await waitFor(() => expect(acceptInvitation).toHaveBeenCalledTimes(1))
		expect(acceptInvitation.mock.calls[0]?.[0]).toEqual({
			invitationId: "inv-1",
			name: "Ada",
			password: "long enough 1",
		})
	})
})
