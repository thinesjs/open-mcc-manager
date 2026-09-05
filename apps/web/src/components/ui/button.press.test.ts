import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const here = dirname(fileURLToPath(import.meta.url))
const button = readFileSync(join(here, "button.tsx"), "utf8")
const hold = readFileSync(join(here, "hold-to-confirm.tsx"), "utf8")
const shell = readFileSync(join(here, "..", "..", "routes", "_authenticated.tsx"), "utf8")

const PRESSABLE = [
	["button", button],
	["sidebar", shell],
] as const

describe("press feedback", () => {
	it("scales every pressable control down on press", () => {
		for (const [name, source] of PRESSABLE) {
			expect(source, name).toMatch(/active[^"]*:scale-\[0\.9[78]\]/)
		}
	})

	it("takes its timing from the shared motion tokens rather than a loose number", () => {
		expect(button).toContain("duration-[var(--duration-press)]")
		expect(button).toContain("ease-[var(--ease-emphasis)]")
	})

	it("transitions transform, or the scale would snap", () => {
		expect(button).toContain("transition-[box-shadow,transform]")
	})

	it("removes the movement for anyone who asked for reduced motion", () => {
		for (const [name, source] of PRESSABLE) {
			expect(source, name).toContain("motion-reduce:transition-none")
			expect(source, name).toMatch(/motion-reduce:[^"]*scale-100/)
		}
	})

	it("gives the hold control its size and feedback from the shared variants, not its own classes", () => {
		expect(hold).toContain("buttonVariants(")
		expect(hold).not.toMatch(/className="[^"]*\bh-\d/)
	})
})
