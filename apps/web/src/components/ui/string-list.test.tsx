import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { StringList } from "./string-list"

const LABEL = "Alert words"
const TWO = ["diamond", "netherite"] as const
const ISSUE = "Too many words"

afterEach(cleanup)

const at = (elements: readonly HTMLElement[], index: number): HTMLElement => {
	const found = elements[index]
	if (found === undefined) throw new Error(`expected an element at ${index}`)
	return found
}

const boxes = () => screen.getAllByLabelText(LABEL)

describe("what the list puts on the page", () => {
	it("gives every entry its own box", () => {
		render(<StringList label={LABEL} values={TWO} issue={null} onChange={() => undefined} />)

		expect(boxes()).toHaveLength(2)
		expect(at(boxes(), 0)).toHaveProperty("value", "diamond")
		expect(at(boxes(), 1)).toHaveProperty("value", "netherite")
	})

	it("keeps both of two identical entries", () => {
		render(
			<StringList
				label={LABEL}
				values={["diamond", "diamond"]}
				issue={null}
				onChange={() => undefined}
			/>,
		)

		expect(boxes()).toHaveLength(2)
	})

	it("offers the add control with nothing listed", () => {
		render(<StringList label={LABEL} values={[]} issue={null} onChange={() => undefined} />)

		expect(screen.queryAllByLabelText(LABEL)).toEqual([])
		expect(screen.getByText("Add")).toBeDefined()
	})

	it("shows the issue it was given", () => {
		render(<StringList label={LABEL} values={TWO} issue={ISSUE} onChange={() => undefined} />)

		expect(screen.queryAllByText(ISSUE)).toHaveLength(1)
	})

	it("shows nothing when there is no issue", () => {
		render(<StringList label={LABEL} values={TWO} issue={null} onChange={() => undefined} />)

		expect(screen.queryByText(ISSUE)).toBeNull()
	})
})

describe("what the controls hand back", () => {
	it("appends an empty entry when the add control is pressed", () => {
		const onChange = vi.fn()
		render(<StringList label={LABEL} values={TWO} issue={null} onChange={onChange} />)

		fireEvent.click(screen.getByText("Add"))

		expect(onChange).toHaveBeenCalledWith([...TWO, ""])
	})

	it("drops only the entry whose remove control was pressed", () => {
		const onChange = vi.fn()
		render(<StringList label={LABEL} values={TWO} issue={null} onChange={onChange} />)

		fireEvent.click(at(screen.getAllByText("Remove"), 1))

		expect(onChange).toHaveBeenCalledWith(["diamond"])
	})

	it("rewrites only the entry that was typed into", () => {
		const onChange = vi.fn()
		render(<StringList label={LABEL} values={TWO} issue={null} onChange={onChange} />)

		fireEvent.change(at(boxes(), 1), { target: { value: "elytra" } })

		expect(onChange).toHaveBeenCalledWith(["diamond", "elytra"])
	})
})

describe("typing into an entry", () => {
	it("keeps the operator in the same box as the text changes", () => {
		const { rerender } = render(
			<StringList label="Words" values={["ab"]} issue={null} onChange={() => undefined} />,
		)
		const box = screen.getByLabelText("Words")
		box.focus()

		rerender(<StringList label="Words" values={["abc"]} issue={null} onChange={() => undefined} />)

		expect(document.activeElement).toBe(screen.getByLabelText("Words"))
	})

	it("keeps the caret in the second of two identical boxes while that one is edited", () => {
		const { rerender } = render(
			<StringList
				label="Words"
				values={["same", "same"]}
				issue={null}
				onChange={() => undefined}
			/>,
		)
		at(screen.getAllByLabelText("Words"), 1).focus()

		rerender(
			<StringList
				label="Words"
				values={["same", "samer"]}
				issue={null}
				onChange={() => undefined}
			/>,
		)

		const second = at(screen.getAllByLabelText("Words"), 1)
		expect(second).toHaveProperty("value", "samer")
		expect(document.activeElement).toBe(second)
	})
})
