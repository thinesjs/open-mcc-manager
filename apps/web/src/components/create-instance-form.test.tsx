import { createInstanceInput } from "@open-mcc/contracts"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { CreateInstanceForm } from "./create-instance-form"
import { AUTO_DETECT_LABEL } from "./minecraft-version-select"

const create = vi.fn()

vi.mock("~/lib/trpc", () => ({
	useTRPC: () => ({
		host: {
			list: {
				queryOptions: () => ({
					queryKey: ["host", "list"],
					queryFn: async () => [{ id: "host-1", name: "tjsx100", status: "ready" }],
				}),
			},
		},
		instance: {
			create: { mutationOptions: () => ({ mutationFn: create }) },
			list: { queryKey: () => ["instance", "list"] },
		},
	}),
}))

const mount = () => {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	})
	return render(
		<QueryClientProvider client={client}>
			<CreateInstanceForm hostId="host-1" onCreated={vi.fn()} onCancel={vi.fn()} />
		</QueryClientProvider>,
	)
}

const fillIn = async () => {
	await waitFor(() => expect(screen.getByLabelText("Name")).toBeDefined())
	fireEvent.change(screen.getByLabelText("Name"), { target: { value: "afk-1" } })
	fireEvent.change(screen.getByLabelText("Email address"), {
		target: { value: "afk@example.com" },
	})
	fireEvent.change(screen.getByLabelText("Server address"), {
		target: { value: "play.skyblock.net" },
	})
}

const submit = async () => {
	screen.getByText("Create instance").click()
	await act(async () => undefined)
}

const sent = () => create.mock.calls[0]?.[0]

beforeEach(() => {
	create.mockResolvedValue({ id: "abc123" })
})

afterEach(() => {
	cleanup()
	create.mockReset()
})

describe("choosing a Minecraft version while creating a bot", () => {
	it("★ starts on auto-detect, so a new bot needs no decision about versions", async () => {
		mount()
		await fillIn()

		expect(screen.getByLabelText("Minecraft version").textContent).toContain(AUTO_DETECT_LABEL)

		await submit()

		expect(sent()?.minecraftVersion).toBe("auto")
	})

	it("★ sends a version the server will accept", async () => {
		mount()
		await fillIn()
		await submit()

		expect(createInstanceInput.safeParse(sent()).success).toBe(true)
	})
})
