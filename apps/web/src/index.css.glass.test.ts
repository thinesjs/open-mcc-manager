import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

const css = readFileSync(join(__dirname, "index.css"), "utf8")

const GLASS_UTILITIES = ["surface-glass", "dropdown-glass"] as const

const blockAt = (source: string, markerIndex: number): string => {
	if (markerIndex === -1) return ""
	const open = source.indexOf("{", markerIndex)
	if (open === -1) return ""
	let depth = 0
	for (let index = open; index < source.length; index += 1) {
		const character = source[index]
		if (character === "{") depth += 1
		if (character === "}") {
			depth -= 1
			if (depth === 0) return source.slice(open + 1, index)
		}
	}
	return ""
}

const utilityBody = (name: string): string => blockAt(css, css.indexOf(`@utility ${name} {`))

const beforeAnyGuard = (body: string): string => {
	const guard = body.indexOf("@supports")
	return guard === -1 ? body : body.slice(0, guard)
}

const fallbackBody = (body: string): string => blockAt(body, body.indexOf("@supports not "))

describe("glass surfaces keep the fallback shape the build requires", () => {
	for (const name of GLASS_UTILITIES) {
		it(`${name} applies its translucent background and blur unconditionally`, () => {
			const unguarded = beforeAnyGuard(utilityBody(name))
			expect(unguarded).toContain("color-mix(")
			expect(unguarded).toContain("backdrop-filter: blur(")
		})

		it(`${name} keeps its opaque fallback behind @supports not, marked important`, () => {
			const body = utilityBody(name)
			expect(body).toContain("@supports not ")
			expect(body).not.toContain("@supports (")
			expect(fallbackBody(body)).toMatch(/background:[^;]*!important/)
		})
	}
})
