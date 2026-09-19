import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, "status-transition.tsx"), "utf8")

describe("status that changes while nobody is looking at it", () => {
	it("does not animate on first paint, which would be a page full of fades", () => {
		expect(source).toContain("initial={false}")
		expect(source).toContain("if (!animate) return")
	})

	it("crossfades rather than moving, since a badge has nowhere to travel to", () => {
		expect(source).toContain("opacity")
		expect(source).not.toContain("x:")
		expect(source).not.toContain("scale:")
	})

	it("stays under the threshold where a transition starts costing the reader time", () => {
		expect(source).toContain("SELF_ARRIVING_MS = 180")
	})

	it("swaps one badge for the next rather than overlapping them", () => {
		expect(source).toContain('mode="wait"')
	})
})
