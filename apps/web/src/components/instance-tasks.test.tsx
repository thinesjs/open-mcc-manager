import type { InstanceTaskPublic } from "@open-mcc/contracts"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { InstanceTasks } from "./instance-tasks"

const saved = vi.fn()
const removed = vi.fn()
let listed: InstanceTaskPublic[] = []

vi.mock("~/lib/trpc", () => ({
	useTRPC: () => ({
		instance: {
			listTasks: {
				queryOptions: () => ({ queryKey: ["tasks"], queryFn: async () => listed }),
			},
			setTask: { mutationOptions: (options: object) => ({ mutationFn: saved, ...options }) },
			deleteTask: { mutationOptions: (options: object) => ({ mutationFn: removed, ...options }) },
		},
	}),
}))

const task = (overrides: Partial<InstanceTaskPublic> = {}): InstanceTaskPublic => ({
	id: "task-1",
	instanceId: "inst-1",
	name: "Switch to eco",
	steps: [
		{ position: 0, command: "/economy" },
		{ position: 1, command: "/local" },
		{ position: 2, command: "/visit .ArrayIndexInOfB" },
	],
	stepDelaySeconds: 3,
	enabled: true,
	timezone: "Europe/London",
	onFirstLogin: false,
	onLogin: true,
	onRespawn: false,
	times: [],
	interval: null,
	nextIntervalRunAt: null,
	lastRunAt: null,
	lastRunError: null,
	runs: [],
	...overrides,
})

const mount = () => {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	})
	return render(
		<QueryClientProvider client={client}>
			<InstanceTasks instanceId="inst-1" />
		</QueryClientProvider>,
	)
}

beforeEach(() => {
	listed = []
	saved.mockReset()
	removed.mockReset()
})

afterEach(cleanup)

describe("the tasks panel", () => {
	it("numbers the steps in the order they will be sent", async () => {
		listed = [task()]
		mount()

		const steps = await screen.findAllByText(/^\d\. \//)
		expect(steps.map((node) => node.textContent)).toEqual([
			"1. /economy",
			"2. /local",
			"3. /visit .ArrayIndexInOfB",
		])
	})

	it("says what fires the task and how long it waits between steps", async () => {
		listed = [task()]
		mount()

		const line = await screen.findByText(/Every login/)
		expect(line.textContent).toContain("3s between steps")
		expect(line.textContent).toContain("never run")
	})

	it("says a task is paused rather than leaving it looking live", async () => {
		listed = [task({ enabled: false })]
		mount()

		expect((await screen.findByText(/Every login/)).textContent).toContain("Paused")
	})

	it("shows the failure a run left behind, naming the step", async () => {
		listed = [task({ lastRunError: "Step 2 of 3 failed and the rest were not sent" })]
		mount()

		expect(
			await screen.findByText(/Last run failed: Step 2 of 3 failed and the rest were not sent/),
		).toBeTruthy()
	})

	it("sends the steps it was given, in order, with the triggers that were picked", async () => {
		mount()

		fireEvent.click(await screen.findByRole("button", { name: "Add" }))
		fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Switch to eco" } })
		fireEvent.change(screen.getByLabelText("Step 1"), { target: { value: "/economy" } })
		fireEvent.click(screen.getByRole("button", { name: "Add step" }))
		fireEvent.change(screen.getByLabelText("Step 2"), { target: { value: "/local" } })
		fireEvent.click(screen.getByRole("button", { name: "Every login" }))
		fireEvent.click(screen.getByRole("button", { name: "Save task" }))

		await waitFor(() => expect(saved).toHaveBeenCalled())
		expect(saved.mock.calls[0]?.[0]).toMatchObject({
			id: null,
			instanceId: "inst-1",
			name: "Switch to eco",
			steps: ["/economy", "/local"],
			onLogin: true,
			onFirstLogin: false,
			onRespawn: false,
			times: [],
			interval: null,
		})
	})

	it("will not save a task no trigger would ever fire", async () => {
		mount()

		fireEvent.click(await screen.findByRole("button", { name: "Add" }))
		fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Nothing" } })
		fireEvent.change(screen.getByLabelText("Step 1"), { target: { value: "/economy" } })

		expect(screen.getByRole("button", { name: "Save task" }).hasAttribute("disabled")).toBe(true)
	})

	it("will not save a task with no step", async () => {
		mount()

		fireEvent.click(await screen.findByRole("button", { name: "Add" }))
		fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Empty" } })
		fireEvent.click(screen.getByRole("button", { name: "Every login" }))

		expect(screen.getByRole("button", { name: "Save task" }).hasAttribute("disabled")).toBe(true)
	})

	it("keeps what was typed in each step when one above it is removed", async () => {
		mount()

		fireEvent.click(await screen.findByRole("button", { name: "Add" }))
		fireEvent.change(screen.getByLabelText("Step 1"), { target: { value: "/economy" } })
		fireEvent.click(screen.getByRole("button", { name: "Add step" }))
		fireEvent.change(screen.getByLabelText("Step 2"), { target: { value: "/local" } })
		fireEvent.click(screen.getByRole("button", { name: "Remove step 1" }))

		expect(screen.getByLabelText("Step 1").getAttribute("value")).toBe("/local")
	})

	it("sends an interval with both bounds, so an exact repeat is possible", async () => {
		mount()

		fireEvent.click(await screen.findByRole("button", { name: "Add" }))
		fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Hourly" } })
		fireEvent.change(screen.getByLabelText("Step 1"), { target: { value: "/economy" } })
		fireEvent.click(screen.getByRole("button", { name: "Repeat" }))
		fireEvent.click(screen.getByRole("button", { name: "Save task" }))

		await waitFor(() => expect(saved).toHaveBeenCalled())
		expect(saved.mock.calls[0]?.[0]).toMatchObject({
			interval: { minSeconds: 3600, maxSeconds: 3600 },
		})
	})

	it("carries the task's own id when an existing one is edited", async () => {
		listed = [task()]
		mount()

		fireEvent.click(await screen.findByRole("button", { name: "Edit Switch to eco" }))
		fireEvent.click(screen.getByRole("button", { name: "Save task" }))

		await waitFor(() => expect(saved).toHaveBeenCalled())
		expect(saved.mock.calls[0]?.[0]).toMatchObject({
			id: "task-1",
			steps: ["/economy", "/local", "/visit .ArrayIndexInOfB"],
		})
	})

	it("keeps a paused task paused when it is edited, and resumes it on the resume button", async () => {
		listed = [task({ enabled: false })]
		mount()

		fireEvent.click(await screen.findByRole("button", { name: "Resume Switch to eco" }))

		await waitFor(() => expect(saved).toHaveBeenCalled())
		expect(saved.mock.calls[0]?.[0]).toMatchObject({ id: "task-1", enabled: true })
	})

	it("deletes by id", async () => {
		listed = [task()]
		mount()

		fireEvent.click(await screen.findByRole("button", { name: "Delete Switch to eco" }))

		await waitFor(() => expect(removed).toHaveBeenCalled())
		expect(removed.mock.calls[0]?.[0]).toEqual({ id: "task-1" })
	})
})
