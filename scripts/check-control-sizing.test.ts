import { describe, expect, it } from "vitest"
import { findViolations } from "./check-control-sizing.mjs"

const label = "file.tsx"

describe("controls that set their own size", () => {
	it("flags a button that hardcodes a height beside one that does not", () => {
		const source = `<button className="flex h-9 items-center sm:h-8">Remove</button>`
		expect(findViolations(source, label)).toHaveLength(1)
	})

	it("flags an anchor styled as a button", () => {
		const source = `<a href="/x" className="inline-flex h-10 px-3">Enroll</a>`
		expect(findViolations(source, label)).toHaveLength(1)
	})

	it("accepts a control that takes its size from the shared variants", () => {
		const source = `<button className={cn(buttonVariants({ size: "sm" }), "relative h-9")}>Go</button>`
		expect(findViolations(source, label)).toEqual([])
	})

	it("leaves decorative elements alone, which are not controls", () => {
		const source = `<span className="grid size-7 place-items-center rounded-full">M</span>`
		expect(findViolations(source, label)).toEqual([])
	})

	it("is not confused by an arrow function inside the opening tag", () => {
		const source = [
			"<button",
			"  onKeyDown={(event) => handle(event)}",
			'  className="flex h-9 items-center"',
			">Hold</button>",
		].join("\n")
		expect(findViolations(source, label)).toHaveLength(1)
	})

	it("reports the line the offending class sits on", () => {
		const source = ["<button", '  className="h-9"', ">x</button>"].join("\n")
		expect(findViolations(source, label)[0]).toContain("file.tsx:2")
	})
})
