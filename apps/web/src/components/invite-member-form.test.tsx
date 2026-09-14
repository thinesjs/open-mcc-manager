import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { InviteMemberForm } from "./invite-member-form"

const invite = vi.fn()

vi.mock("~/lib/trpc", () => ({
	useTRPC: () => ({
		member: { invite: { mutationOptions: () => ({ mutationFn: invite }) } },
	}),
}))

afterEach(() => {
	cleanup()
	invite.mockReset()
})

const mount = () => {
	const onInvited = vi.fn()
	const onClose = vi.fn()
	const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
	render(
		<QueryClientProvider client={client}>
			<InviteMemberForm onInvited={onInvited} onClose={onClose} />
		</QueryClientProvider>,
	)
	return { onInvited, onClose }
}

const typeEmail = (value: string) => {
	fireEvent.change(screen.getByLabelText("Email"), { target: { value } })
}

const submit = () => {
	fireEvent.click(screen.getByRole("button", { name: "Invite" }))
}

describe("inviting a member", () => {
	it("sends the email and role, then hands back a link that opens this invitation", async () => {
		invite.mockResolvedValue({ id: "inv-9" })
		const { onInvited } = mount()

		typeEmail("new@example.com")
		fireEvent.click(screen.getByText("Operator"))
		submit()

		const link = `${window.location.origin}/accept-invitation?invitation=inv-9`
		await waitFor(() => expect(screen.getByDisplayValue(link)).toBeDefined())
		expect(invite.mock.calls[0]?.[0]).toEqual({ email: "new@example.com", role: "operator" })
		expect(onInvited).toHaveBeenCalledTimes(1)
		expect(screen.getByRole("button", { name: "Copy invitation link" })).toBeDefined()
	})

	it("gives the least access unless the owner picks more", async () => {
		invite.mockResolvedValue({ id: "inv-1" })
		mount()

		typeEmail("new@example.com")
		submit()

		await waitFor(() => expect(invite).toHaveBeenCalledTimes(1))
		expect(invite.mock.calls[0]?.[0]).toEqual({ email: "new@example.com", role: "viewer" })
	})

	it("reads Inviting while it waits", async () => {
		invite.mockReturnValue(new Promise(() => undefined))
		mount()

		typeEmail("new@example.com")
		submit()

		await waitFor(() => expect(screen.getByRole("img", { name: "Inviting" })).toBeDefined())
	})

	it("says why an invite failed in local copy", async () => {
		invite.mockRejectedValue(
			Object.assign(new Error("USER_IS_ALREADY_INVITED_TO_THIS_ORGANIZATION"), {
				data: { errorCode: "MEMBER_ALREADY_INVITED" },
			}),
		)
		const { onInvited } = mount()

		typeEmail("new@example.com")
		submit()

		await waitFor(() => expect(screen.getByText(/already/)).toBeDefined())
		expect(screen.queryByText(/USER_IS_ALREADY/)).toBeNull()
		expect(onInvited).not.toHaveBeenCalled()
	})
})
