import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { NAV_STATIC_WIDTH, useNavDrawer } from "./nav-drawer"

afterEach(cleanup)

const Harness = () => {
	const nav = useNavDrawer()
	return (
		<div>
			<aside ref={nav.panelRef} tabIndex={-1} data-open={nav.open}>
				<button type="button">First</button>
				<button type="button" onClick={nav.close}>
					Somewhere
				</button>
			</aside>
			<main inert={nav.open} data-inert={nav.open}>
				<button ref={nav.openerRef} type="button" aria-expanded={nav.open} onClick={nav.show}>
					Open menu
				</button>
				<button type="button">Behind</button>
			</main>
		</div>
	)
}

const sendKey = (key: string, shiftKey = false): KeyboardEvent => {
	const event = new KeyboardEvent("keydown", { key, shiftKey, bubbles: true, cancelable: true })
	document.dispatchEvent(event)
	return event
}

const opener = () => screen.getByText("Open menu")
const panel = () => {
	const found = document.querySelector("aside")
	if (found === null) throw new Error("expected the panel")
	return found
}

describe("the menu drawer's keyboard behaviour", () => {
	it("★ moves focus into the menu when it opens, rather than leaving it on the button behind", () => {
		render(<Harness />)
		opener().focus()

		fireEvent.click(opener())

		expect(panel().dataset.open).toBe("true")
		expect(document.activeElement).toBe(panel())
	})

	it("★ closes on Escape and hands focus back to the button that opened it", () => {
		render(<Harness />)
		fireEvent.click(opener())

		fireEvent.keyDown(document, { key: "Escape" })

		expect(panel().dataset.open).toBe("false")
		expect(document.activeElement).toBe(opener())
	})

	it("ignores other keys, so typing does not shut the menu", () => {
		render(<Harness />)
		fireEvent.click(opener())

		fireEvent.keyDown(document, { key: "a" })

		expect(panel().dataset.open).toBe("true")
	})

	it("★ stops listening once it is closed, so Escape elsewhere is not ours to swallow", () => {
		render(<Harness />)
		fireEvent.click(opener())
		fireEvent.keyDown(document, { key: "Escape" })

		expect(sendKey("Escape").defaultPrevented).toBe(false)
	})

	it("★ hands focus back when something inside the menu closes it, not only Escape", () => {
		render(<Harness />)
		fireEvent.click(opener())

		fireEvent.click(screen.getByText("Somewhere"))

		expect(panel().dataset.open).toBe("false")
		expect(document.activeElement).toBe(opener())
	})

	it("tells a screen reader whether it is open", () => {
		render(<Harness />)

		expect(opener().getAttribute("aria-expanded")).toBe("false")
		fireEvent.click(opener())
		expect(opener().getAttribute("aria-expanded")).toBe("true")
	})
})

describe("what the menu does to the page behind it", () => {
	it("★ makes the page inert while it is open, so Tab cannot reach what the scrim covers", () => {
		render(<Harness />)
		const page = document.querySelector("main")

		expect(page?.hasAttribute("inert")).toBe(false)
		fireEvent.click(opener())
		expect(page?.hasAttribute("inert")).toBe(true)
	})

	it("★ gives the page back when it closes, or the operator would be locked out", () => {
		render(<Harness />)
		fireEvent.click(opener())

		fireEvent.keyDown(document, { key: "Escape" })

		expect(document.querySelector("main")?.hasAttribute("inert")).toBe(false)
	})

	it("★ closes itself when the window grows to where the menu is part of the page", () => {
		render(<Harness />)
		fireEvent.click(opener())

		window.innerWidth = NAV_STATIC_WIDTH
		fireEvent(window, new Event("resize"))

		expect(panel().dataset.open).toBe("false")
		expect(document.querySelector("main")?.hasAttribute("inert")).toBe(false)
	})

	it("stays open when the window is still narrow", () => {
		render(<Harness />)
		fireEvent.click(opener())

		window.innerWidth = NAV_STATIC_WIDTH - 1
		fireEvent(window, new Event("resize"))

		expect(panel().dataset.open).toBe("true")
	})
})

describe("keeping Tab inside the open menu", () => {
	const focusables = (): readonly HTMLElement[] => [
		...panel().querySelectorAll<HTMLElement>("button"),
	]

	it("★ wraps from the last control back to the first", () => {
		render(<Harness />)
		fireEvent.click(opener())
		const last = focusables()[focusables().length - 1]
		last?.focus()

		fireEvent.keyDown(document, { key: "Tab" })

		expect(document.activeElement).toBe(focusables()[0])
	})

	it("★ wraps backwards from the first control to the last", () => {
		render(<Harness />)
		fireEvent.click(opener())
		focusables()[0]?.focus()

		fireEvent.keyDown(document, { key: "Tab", shiftKey: true })

		expect(document.activeElement).toBe(focusables()[focusables().length - 1])
	})

	it("★ leaves an ordinary Tab in the middle of the menu to the browser", () => {
		render(<Harness />)
		fireEvent.click(opener())
		const middle = focusables()[focusables().length - 2]
		middle?.focus()

		expect(sendKey("Tab").defaultPrevented).toBe(false)
	})

	it("★ takes the wrapping Tab over, which is what stops focus leaving", () => {
		render(<Harness />)
		fireEvent.click(opener())
		focusables()[focusables().length - 1]?.focus()

		expect(sendKey("Tab").defaultPrevented).toBe(true)
	})
})
