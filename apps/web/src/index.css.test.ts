import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

const css = readFileSync(join(__dirname, "index.css"), "utf8")

describe("design tokens mirrored from the reference", () => {
	it("declares the radius scale", () => {
		expect(css).toContain("--radius: 0.625rem")
		expect(css).toContain("--control-radius: 0.5rem")
	})

	it("declares both primary values", () => {
		expect(css).toContain("--primary: oklch(0.488 0.217 264)")
		expect(css).toContain("--primary: oklch(0.588 0.217 264)")
	})

	it("declares the terminal family used by the console", () => {
		for (const token of [
			"--terminal-background",
			"--terminal-foreground",
			"--terminal-cursor",
			"--terminal-selection-background",
		]) {
			expect(css).toContain(token)
		}
	})

	it("uses the tailwind v4 dark variant rather than a media query only", () => {
		expect(css).toContain("@custom-variant dark")
	})

	it("declares the status family with foreground and surface variants where the reference defines them", () => {
		for (const token of [
			"--error",
			"--error-foreground",
			"--error-surface",
			"--warning",
			"--warning-foreground",
			"--warning-surface",
			"--success",
			"--success-foreground",
			"--info",
			"--info-foreground",
			"--update",
			"--update-foreground",
			"--update-surface",
		]) {
			expect(css).toContain(token)
		}
	})

	it("declares the sidebar family", () => {
		for (const token of [
			"--sidebar:",
			"--sidebar-foreground",
			"--sidebar-muted-foreground",
			"--sidebar-border",
		]) {
			expect(css).toContain(token)
		}
	})
})
