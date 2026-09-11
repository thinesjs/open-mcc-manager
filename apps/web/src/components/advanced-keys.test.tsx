import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ADVANCED_KEY_OPTIONS, validateAdvancedKeyRows } from "~/lib/advanced-key-rows"
import { AdvancedKeys } from "./advanced-keys"

const TWO_ROWS = [
	{ key: "ChatBot.AutoEat.Enabled", value: "true" },
	{ key: "ChatBot.AutoFishing.Auto_Start", value: "false" },
] as const

afterEach(cleanup)

describe("what the editor puts on the page", () => {
	it("renders every row it is given", () => {
		render(<AdvancedKeys rows={TWO_ROWS} issues={[null, null]} onChange={() => undefined} />)

		expect(screen.getByText("ChatBot.AutoEat.Enabled")).toBeDefined()
		expect(screen.getByText("ChatBot.AutoFishing.Auto_Start")).toBeDefined()
	})

	it("shows an issue against the row it belongs to, leaving the other row's value intact", () => {
		render(
			<AdvancedKeys
				rows={TWO_ROWS}
				issues={[null, "Must be true or false"]}
				onChange={() => undefined}
			/>,
		)

		const values = screen.getAllByLabelText("Value")
		expect(screen.getByText("Must be true or false")).toBeDefined()
		expect(values[0]).toHaveProperty("value", "true")
	})

	it("shows nothing at all when no row carries an issue", () => {
		render(<AdvancedKeys rows={TWO_ROWS} issues={[null, null]} onChange={() => undefined} />)

		expect(screen.queryByText("Must be true or false")).toBeNull()
		expect(screen.queryByText("Choose a key")).toBeNull()
	})

	it("asks an unselected row to choose, and offers the add control from empty", () => {
		render(
			<AdvancedKeys
				rows={[{ key: null, value: "" }]}
				issues={["Choose a key"]}
				onChange={() => undefined}
			/>,
		)

		expect(screen.queryAllByText("Choose a key").length).toBeGreaterThan(0)
		expect(screen.getByText("Add a key")).toBeDefined()
	})
})

describe("the key selector the operator picks from", () => {
	it("offers exactly the registry, once its portal is opened", async () => {
		render(<AdvancedKeys rows={[TWO_ROWS[0]]} issues={[null]} onChange={() => undefined} />)
		screen.getByRole("combobox").click()

		const offered = (await screen.findAllByRole("option")).map((option) => option.textContent)
		expect([...offered].sort()).toEqual([...ADVANCED_KEY_OPTIONS].sort())
	})
})

describe("a value control that matches its key", () => {
	it("gives an enum key its members as radios rather than a free text box", () => {
		render(
			<AdvancedKeys
				rows={[{ key: "ChatBot.AutoAttack.Interaction", value: "Attack" }]}
				issues={[null]}
				onChange={() => undefined}
			/>,
		)

		const members = screen.getAllByRole("radio").map((radio) => radio.getAttribute("value"))
		expect(members).toEqual(["Interact", "Attack", "InteractAt"])
		expect(screen.queryByLabelText("Value")).toBeNull()
	})

	it("gives a literal key a text box", () => {
		render(
			<AdvancedKeys
				rows={[{ key: "ChatBot.AutoEat.Threshold", value: "5" }]}
				issues={[null]}
				onChange={() => undefined}
			/>,
		)

		expect(screen.getByLabelText("Value")).toHaveProperty("value", "5")
		expect(screen.queryAllByRole("radio")).toEqual([])
	})
})

describe("two rows on the same key", () => {
	it("shows the duplicate against both of them", () => {
		const rows = [
			{ key: "ChatBot.ItemsCollector.Collection_Radius", value: "1.5" },
			{ key: "ChatBot.ItemsCollector.Collection_Radius", value: "2.5" },
		] as const
		render(
			<AdvancedKeys
				rows={rows}
				issues={validateAdvancedKeyRows(rows)}
				onChange={() => undefined}
			/>,
		)

		expect(screen.getAllByText("Duplicate key")).toHaveLength(2)
		expect(screen.queryByText("Decimal number")).toBeNull()
	})
})

describe("what the controls hand back", () => {
	it("appends an unselected row when the add control is pressed", () => {
		const onChange = vi.fn()
		render(<AdvancedKeys rows={TWO_ROWS} issues={[null, null]} onChange={onChange} />)

		screen.getByText("Add a key").click()

		expect(onChange).toHaveBeenCalledWith([...TWO_ROWS, { key: null, value: "" }])
	})

	it("drops only the row whose remove control was pressed", () => {
		const onChange = vi.fn()
		render(<AdvancedKeys rows={TWO_ROWS} issues={[null, null]} onChange={onChange} />)

		const removes = screen.getAllByText("Remove")
		removes[1]?.click()

		expect(onChange).toHaveBeenCalledWith([TWO_ROWS[0]])
	})

	it("sets the key and clears the value when an option is chosen", async () => {
		const onChange = vi.fn()
		render(
			<AdvancedKeys rows={[{ key: null, value: "1.5" }]} issues={[null]} onChange={onChange} />,
		)

		screen.getByRole("combobox").click()
		const chosen = await screen.findByText("ChatBot.AutoEat.Threshold")
		chosen.click()

		expect(onChange).toHaveBeenCalledWith([{ key: "ChatBot.AutoEat.Threshold", value: "" }])
	})
})
