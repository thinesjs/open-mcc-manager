import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "spinner.tsx"), "utf8")

describe("the spinner shown while something is in flight", () => {
	it("carries a label for assistive technology, since it has no visible text", () => {
		expect(source).toContain("aria-label={label}")
		expect(source).toContain("<title>{label}</title>")
	})

	it("takes its colour from the surrounding text, so it works in either theme", () => {
		expect(source).toContain('stroke="currentColor"')
		expect(source).not.toMatch(/stroke="#|text-(white|black)/)
	})

	it("stops animating for anyone who asked for less motion", () => {
		expect(source).toContain("motion-reduce:animate-none")
	})

	it("aligns to the start of its row rather than centring", () => {
		expect(source).toContain("flex items-center")
		expect(source).not.toContain("justify-center")
	})
})
