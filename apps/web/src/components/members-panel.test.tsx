import type { Role } from "@open-mcc/contracts"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { MembersPanel } from "./members-panel"

const listMembers = vi.fn()
const listInvitations = vi.fn()
const remove = vi.fn()
const cancel = vi.fn()
const invite = vi.fn()

vi.mock("~/lib/trpc", () => ({
	useTRPC: () => ({
		member: {
			list: {
				queryOptions: () => ({ queryKey: ["member", "list"], queryFn: listMembers }),
				queryKey: () => ["member", "list"],
			},
			invitations: {
				queryOptions: () => ({ queryKey: ["member", "invitations"], queryFn: listInvitations }),
				queryKey: () => ["member", "invitations"],
			},
			remove: { mutationOptions: () => ({ mutationFn: remove }) },
			cancelInvitation: { mutationOptions: () => ({ mutationFn: cancel }) },
			invite: { mutationOptions: () => ({ mutationFn: invite }) },
		},
	}),
}))

afterEach(() => {
	cleanup()
	for (const mock of [listMembers, listInvitations, remove, cancel, invite]) mock.mockReset()
})

const MEMBERS = [
	{ id: "m1", name: "Ada", email: "ada@example.com", role: "owner", self: true },
	{ id: "m2", name: "Bo", email: "bo@example.com", role: "operator", self: false },
]

const DAY_MS = 86_400_000

const mount = (role: Role) => {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	})
	render(
		<QueryClientProvider client={client}>
			<MembersPanel role={role} />
		</QueryClientProvider>,
	)
}

describe("what each role is offered", () => {
	it("gives an owner the invite button, and a remove button on everyone but themselves", async () => {
		listMembers.mockResolvedValue(MEMBERS)
		listInvitations.mockResolvedValue([])
		mount("owner")

		await waitFor(() => expect(screen.getByText("bo@example.com")).toBeDefined())
		expect(screen.getByRole("button", { name: "Invite" })).toBeDefined()
		expect(screen.getByRole("button", { name: "Remove Bo" })).toBeDefined()
		expect(screen.queryByRole("button", { name: "Remove Ada" })).toBeNull()
		expect(screen.getByText("You")).toBeDefined()
	})

	it.each(["operator", "viewer"] as const)(
		"gives a %s nothing to press and never asks for the list",
		(role) => {
			mount(role)

			expect(screen.queryByRole("button", { name: "Invite" })).toBeNull()
			expect(screen.queryByRole("button", { name: /Remove/ })).toBeNull()
			expect(screen.getByText("Only owners can manage members.")).toBeDefined()
			expect(listMembers).not.toHaveBeenCalled()
			expect(listInvitations).not.toHaveBeenCalled()
		},
	)
})

describe("removing a member", () => {
	it("asks first, and removes only once the hold completes", async () => {
		listMembers.mockResolvedValue(MEMBERS)
		listInvitations.mockResolvedValue([])
		remove.mockResolvedValue(true)
		mount("owner")

		await waitFor(() => expect(screen.getByRole("button", { name: "Remove Bo" })).toBeDefined())
		fireEvent.click(screen.getByRole("button", { name: "Remove Bo" }))

		expect(screen.getByText(/loses access right away/)).toBeDefined()
		expect(screen.queryByText(/signed out/)).toBeNull()
		const hold = screen.getByRole("button", { name: "Remove. Press and hold to confirm." })
		fireEvent.click(hold)
		expect(remove).not.toHaveBeenCalled()

		fireEvent.pointerDown(hold)
		await act(() => new Promise((resolve) => setTimeout(resolve, 1_000)))

		await waitFor(() => expect(remove.mock.calls[0]?.[0]).toEqual({ memberId: "m2" }))
	})
})

describe("invitations still waiting", () => {
	it("offers the link to copy and cancels the invitation it names", async () => {
		listMembers.mockResolvedValue(MEMBERS)
		listInvitations.mockResolvedValue([
			{
				id: "inv-1",
				email: "new@example.com",
				role: "viewer",
				expiresAt: new Date(Date.now() + 2 * DAY_MS).toISOString(),
			},
		])
		cancel.mockResolvedValue(true)
		mount("owner")

		await waitFor(() => expect(screen.getByText("new@example.com")).toBeDefined())
		expect(screen.getByRole("button", { name: "Copy invitation link" })).toBeDefined()

		fireEvent.click(screen.getByRole("button", { name: "Cancel invitation for new@example.com" }))

		await waitFor(() => expect(cancel.mock.calls[0]?.[0]).toEqual({ invitationId: "inv-1" }))
	})

	it("says when an invitation has run out", async () => {
		listMembers.mockResolvedValue(MEMBERS)
		listInvitations.mockResolvedValue([
			{
				id: "inv-1",
				email: "late@example.com",
				role: "viewer",
				expiresAt: new Date(Date.now() - DAY_MS).toISOString(),
			},
		])
		mount("owner")

		await waitFor(() => expect(screen.getByText("late@example.com")).toBeDefined())
		expect(screen.getByText("Expired")).toBeDefined()
	})
})
