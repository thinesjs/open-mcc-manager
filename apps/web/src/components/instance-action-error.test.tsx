import { ERROR_CODES, type ErrorCode, ROLES, type Role } from "@open-mcc/contracts"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { cleanup, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ASK_AN_OWNER_MESSAGE, InstanceActionError } from "./instance-action-error"

const seat: { role: Role } = { role: "owner" }

const cancelled: string[] = []

const procedure = (name: string) => ({
	queryOptions: () => ({ queryKey: [name], queryFn: () => ({ role: seat.role }) }),
	mutationOptions: (options: object) => ({
		...options,
		mutationFn: (input: { instanceId: string }) => {
			cancelled.push(input.instanceId)
			return Promise.resolve({ authenticated: false, status: "stopped" })
		},
	}),
})

const trpc = new Proxy(
	{},
	{
		get: () => new Proxy({}, { get: (_router, name) => procedure(String(name)) }),
	},
)

vi.mock("~/lib/trpc", () => ({ useTRPC: () => trpc }))

afterEach(() => {
	cleanup()
	cancelled.length = 0
	seat.role = "owner"
})

const show = async (errorCode: ErrorCode, role: Role) => {
	seat.role = role
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	})
	render(
		<QueryClientProvider client={client}>
			<InstanceActionError
				error={{ message: "refused", data: { errorCode, httpStatus: 409 } }}
				instanceId="bot-1"
				busy={false}
				onCancelled={() => undefined}
			/>
		</QueryClientProvider>,
	)
	await screen.findByRole("alert")
	await waitFor(() => expect(client.isFetching()).toBe(0))
}

const cancelButton = () => screen.queryByRole("button", { name: "Cancel sign-in" })

describe("the way out a refusal carries", () => {
	it("★ offers a sign-in to cancel on exactly the refusal a sign-in holds, and on no other", async () => {
		const offering: ErrorCode[] = []
		for (const errorCode of ERROR_CODES) {
			await show(errorCode, "owner")
			if (cancelButton() !== null) offering.push(errorCode)
			cleanup()
		}

		expect(offering).toEqual(["INSTANCE_AUTH_IN_PROGRESS"])
	})

	it("★ names the sign-in hold on exactly that refusal, and leaves every other code its own words", async () => {
		const asking: ErrorCode[] = []
		for (const errorCode of ERROR_CODES) {
			await show(errorCode, "operator")
			if (screen.queryByText(ASK_AN_OWNER_MESSAGE) !== null) asking.push(errorCode)
			cleanup()
		}

		expect(asking).toEqual(["INSTANCE_AUTH_IN_PROGRESS"])
	})
})

describe("who the way out is offered to", () => {
	it("★ offers the cancel only to a role that may cancel, and tells the others who can", async () => {
		const offered: Role[] = []
		const told: Role[] = []
		for (const role of ROLES) {
			await show("INSTANCE_AUTH_IN_PROGRESS", role)
			if (cancelButton() !== null) offered.push(role)
			if (screen.queryByText(ASK_AN_OWNER_MESSAGE) !== null) told.push(role)
			cleanup()
		}

		expect(offered).toEqual(["owner"])
		expect(told).toEqual(["operator", "viewer"])
	})

	it("★ never offers a button whose procedure would answer the presser Forbidden", async () => {
		await show("INSTANCE_AUTH_IN_PROGRESS", "operator")

		expect(cancelButton()).toBeNull()
		expect(screen.getByRole("alert").textContent).toContain("15 minutes")
		expect(screen.getByText(ASK_AN_OWNER_MESSAGE)).toBeDefined()
	})

	it("cancels the instance the refusal came from when an owner presses it", async () => {
		await show("INSTANCE_AUTH_IN_PROGRESS", "owner")
		const button = cancelButton()
		if (button === null) throw new Error("an owner was offered no sign-in to cancel")
		button.click()

		await waitFor(() => expect(cancelled).toEqual(["bot-1"]))
	})
})
