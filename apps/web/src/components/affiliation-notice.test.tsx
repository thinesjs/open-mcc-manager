import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { AffiliationNotice } from "./affiliation-notice"

afterEach(cleanup)

describe("the notice Mojang's guidelines require", () => {
	it("★ still makes both claims the guidelines ask for, however it is punctuated", () => {
		render(<AffiliationNotice />)
		const notice = screen.getByText(/Not an official Minecraft product/).textContent ?? ""

		expect(notice).toContain("Not an official Minecraft product")
		expect(notice).toContain("not approved by or associated with Mojang or Microsoft")
	})

	it("stays quiet in the corner rather than competing with the page", () => {
		const { container } = render(<AffiliationNotice />)
		const classes = container.querySelector("p")?.className.split(" ") ?? []

		expect(classes).toContain("text-[0.6875rem]")
		expect(classes).toContain("text-muted-foreground/70")
		expect(classes).not.toContain("font-medium")
	})

	it("still takes the placement its callers give it", () => {
		const { container } = render(<AffiliationNotice className="text-center" />)

		expect(container.querySelector("p")?.className.split(" ")).toContain("text-center")
	})
})
