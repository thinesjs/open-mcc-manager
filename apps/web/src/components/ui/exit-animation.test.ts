import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const here = dirname(fileURLToPath(import.meta.url))
const SURFACES = [
	["dialog", readFileSync(join(here, "dialog.tsx"), "utf8")],
	["modal", readFileSync(join(here, "modal.tsx"), "utf8")],
] as const

describe("overlay surfaces", () => {
	it("animates out as well as in, so closing is not a single frame", () => {
		for (const [name, source] of SURFACES) {
			expect(source, name).toContain("AnimatePresence")
			expect(source, name).toContain("exit=")
		}
	})

	it("keeps the open check inside the tree, or the exit can never play", () => {
		for (const [name, source] of SURFACES) {
			expect(source, name).not.toContain("if (!open) return null")
		}
	})

	it("moves the overlay and the panel on one transition, so the surface reads as one object", () => {
		for (const [name, source] of SURFACES) {
			expect(source, name).toContain("const surface =")
			expect((source.match(/transition=\{surface\}/g) ?? []).length, name).toBe(2)
		}
	})
})
