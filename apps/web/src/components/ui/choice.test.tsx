import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { Choice } from "./choice"

afterEach(cleanup)

const PAIR = [
	{ value: "on", label: "On" },
	{ value: "off", label: "Off" },
] as const

const spansIn = (label: string): number =>
	screen.getByText(label).closest("label")?.querySelectorAll("span").length ?? 0

const fieldsetOf = (container: HTMLElement): HTMLElement => {
	const found = container.querySelector("fieldset")
	if (found === null) throw new Error("expected a fieldset")
	return found
}

describe("a two-option choice with nothing to explain", () => {
	it("★ sits inline rather than stretching, which is what makes it read as a switch", () => {
		const { container } = render(
			<Choice label="Rejoin" value="on" options={PAIR} onChange={vi.fn()} />,
		)

		expect(fieldsetOf(container).className.split(" ")).toContain("w-fit")
	})

	it("★ applies to ANY two-option pair, the advanced-key editor's enums included", () => {
		const { container } = render(
			<Choice
				label="Mode"
				value="single"
				options={[
					{ value: "single", label: "single" },
					{ value: "multi", label: "multi" },
				]}
				onChange={vi.fn()}
			/>,
		)

		expect(fieldsetOf(container).className.split(" ")).toContain("w-fit")
	})
})

describe("a choice whose options need explaining", () => {
	it("stretches instead, because the descriptions need the room", () => {
		const { container } = render(
			<Choice
				label="Account"
				value="a"
				options={[
					{ value: "a", label: "A", description: "The first one" },
					{ value: "b", label: "B" },
				]}
				onChange={vi.fn()}
			/>,
		)

		expect(fieldsetOf(container).className.split(" ")).not.toContain("w-fit")
		expect(screen.getByText("The first one")).toBeDefined()
	})

	it("★ renders no empty element for an option that has nothing to say", () => {
		render(<Choice label="Rejoin" value="on" options={PAIR} onChange={vi.fn()} />)

		expect(spansIn("Off")).toBe(1)
	})

	it("★ renders exactly one extra element for the option that does have something to say", () => {
		render(
			<Choice
				label="Account"
				value="b"
				options={[
					{ value: "a", label: "A", description: "The first one" },
					{ value: "b", label: "B" },
				]}
				onChange={vi.fn()}
			/>,
		)

		expect(spansIn("A")).toBe(2)
	})
})
