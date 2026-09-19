import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const source = readFileSync(
	join(dirname(fileURLToPath(import.meta.url)), "hold-to-confirm.tsx"),
	"utf8",
)

describe("the hold-to-confirm progress fill", () => {
	it("runs for exactly as long as the hold it reports, so the bar cannot finish early", () => {
		expect(source).toContain("duration: durationMs / 1000")
	})

	it("never shortens that clock for reduced motion, which would make the bar lie", () => {
		const holdTransition = source.slice(
			source.indexOf("holding ?"),
			source.indexOf("{ duration: 0.15 }"),
		)
		expect(holdTransition).not.toContain("reduced")
		expect(holdTransition).not.toContain("0.1")
	})

	it("keeps the fill linear, because it is reporting time passing", () => {
		expect(source).toContain('ease: "linear"')
	})
})
