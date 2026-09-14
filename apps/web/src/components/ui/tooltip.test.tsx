import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { Tooltip } from "./tooltip"

afterEach(cleanup)

describe("stacking above the mobile drawer and other overlays", () => {
	it("puts the popup's positioner above a modal, so it never paints behind one", async () => {
		render(<Tooltip content="Full detail">Short label</Tooltip>)

		fireEvent.focus(screen.getByText("Short label"))

		await waitFor(() => {
			expect(screen.getByText("Full detail")).toBeTruthy()
		})

		const positioner = screen.getByText("Full detail").parentElement
		expect(positioner?.className).toMatch(/\bz-50\b/)
	})
})
