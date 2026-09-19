import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { sidebarClasses } from "~/lib/sidebar"

const here = dirname(fileURLToPath(import.meta.url))
const shell = readFileSync(join(here, "_authenticated.tsx"), "utf8")

const classesOf = (open: boolean): readonly string[] => sidebarClasses(open).split(" ")

const navLink = /<Link[^>]*?to=\{item\.to\}[\s\S]*?>/.exec(shell)?.[0] ?? ""

describe("how the menu looks at each width", () => {
	it("★ leaves the tab order while it is closed, so nothing off-screen takes focus", () => {
		expect(classesOf(false)).toContain("invisible")
		expect(classesOf(false)).toContain("-translate-x-full")
	})

	it("★ shows itself at once when it opens, or focus would land on a hidden element", () => {
		expect(classesOf(true)).toContain("visible")
		expect(classesOf(true)).not.toContain("invisible")
		expect(classesOf(true)).toContain("transition-transform")
	})

	it("★ waits for the slide out before hiding, which it must not do on the way in", () => {
		expect(classesOf(false)).toContain("transition-[transform,visibility]")
		expect(classesOf(true)).not.toContain("transition-[transform,visibility]")
	})

	it("stays visible and in the page, not over it, where there is room for it", () => {
		for (const open of [true, false]) {
			expect(classesOf(open)).toContain("lg:visible")
			expect(classesOf(open)).toContain("lg:static")
			expect(classesOf(open)).toContain("lg:translate-x-0")
		}
	})

	it("★ drops the animation for anyone who asked for reduced motion", () => {
		expect(classesOf(true)).toContain("motion-reduce:transition-none")
	})
})

describe("what the layout wires the drawer up to", () => {
	it("★ closes the menu when a nav link is followed, rather than covering where it went", () => {
		expect(navLink).not.toBe("")
		expect(navLink).toContain("onClick={nav.close}")
	})
})
