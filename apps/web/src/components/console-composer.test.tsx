import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ConsoleComposer, type ConsoleComposerProps } from "./console-composer"

const here = dirname(fileURLToPath(import.meta.url))
const detail = readFileSync(
	join(here, "..", "routes", "_authenticated.instances.$instanceId.tsx"),
	"utf8",
)

const mutate = vi.fn()

vi.mock("~/lib/trpc", () => ({
	useTRPC: () => ({
		instance: { sendCommand: { mutationOptions: () => ({ mutationFn: mutate }) } },
	}),
}))

afterEach(() => {
	cleanup()
	mutate.mockReset()
})

const ONLINE = ["Steve", "Stone_Age", "Alex_99"]

const mount = (overrides: Partial<ConsoleComposerProps> = {}) => {
	const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
	const element = (props: Partial<ConsoleComposerProps>) => (
		<QueryClientProvider client={client}>
			<ConsoleComposer
				instanceId="instance-1"
				running={true}
				players={ONLINE}
				onSent={async () => undefined}
				{...overrides}
				{...props}
			/>
		</QueryClientProvider>
	)
	const view = render(element({}))
	return { again: (props: Partial<ConsoleComposerProps>) => view.rerender(element(props)) }
}

const box = (): HTMLElement => screen.getByLabelText("Message or command")

const type = (value: string) => {
	fireEvent.change(box(), { target: { value } })
}

const offered = (): string[] =>
	screen
		.queryAllByRole("button")
		.map((button) => button.textContent ?? "")
		.filter((label) => ONLINE.includes(label))

describe("the names offered while typing", () => {
	it("offers the players online whose name has been started", () => {
		mount()
		type("/msg St")

		expect(offered()).toEqual(["Steve", "Stone_Age"])
	})

	it("offers nothing on a single letter, so ordinary chat is left alone", () => {
		mount()
		type("S")

		expect(offered()).toEqual([])
	})

	it("offers nothing when nobody is online", () => {
		mount({ players: [] })
		type("/msg St")

		expect(offered()).toEqual([])
	})

	it("offers nothing when the readout has not answered", () => {
		mount({ players: null })
		type("/msg St")

		expect(offered()).toEqual([])
	})

	it("★ takes the names back the moment the instance stops", () => {
		const { again } = mount()
		type("/msg St")
		expect(offered()).toEqual(["Steve", "Stone_Age"])

		again({ running: false })

		expect(offered()).toEqual([])
	})

	it("★ offers nothing at all when one name is not a Minecraft name", () => {
		mount({ players: ["Steve", "<img src=x>"] })
		type("/msg St")

		expect(offered()).toEqual([])
		expect(screen.queryByText("<img src=x>")).toBeNull()
	})
})

describe("choosing a name", () => {
	it("finishes the word in the box", () => {
		mount()
		type("/msg St")
		fireEvent.click(screen.getByRole("button", { name: "Stone_Age" }))

		expect(box()).toHaveProperty("value", "/msg Stone_Age")
	})

	it("★ sends nothing by itself", () => {
		mount()
		type("/msg St")
		fireEvent.click(screen.getByRole("button", { name: "Steve" }))

		expect(mutate).not.toHaveBeenCalled()
	})
})

describe("Tab", () => {
	it("finishes the first name offered and keeps the cursor in the box", () => {
		mount()
		type("/msg St")

		expect(fireEvent.keyDown(box(), { key: "Tab" })).toBe(false)
		expect(box()).toHaveProperty("value", "/msg Steve")
	})

	it("★ still leaves the box when no name is offered", () => {
		mount()
		type("hello there")

		expect(fireEvent.keyDown(box(), { key: "Tab" })).toBe(true)
		expect(box()).toHaveProperty("value", "hello there")
	})

	it("★ still steps backwards when held with Shift", () => {
		mount()
		type("/msg St")

		expect(fireEvent.keyDown(box(), { key: "Tab", shiftKey: true })).toBe(true)
		expect(box()).toHaveProperty("value", "/msg St")
	})
})

describe("how the route feeds the composer", () => {
	it("hands it the same live players readout the panel renders", () => {
		const start = detail.indexOf("<ConsoleComposer")

		expect(detail.slice(start, detail.indexOf("/>", start))).toContain(
			"players={livePlayersQuery.data}",
		)
	})
})
