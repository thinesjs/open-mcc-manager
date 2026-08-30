import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

const css = readFileSync(join(__dirname, "index.css"), "utf8")

const stripComments = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//g, "")

const declaredNames = (source: string): Set<string> => {
	const names = new Set<string>()
	for (const match of stripComments(source).matchAll(/(?:^|[;{}\s])(--[A-Za-z0-9_-]+)\s*:/gm)) {
		const name = match[1]
		if (name !== undefined) names.add(name)
	}
	return names
}

const referencedNames = (source: string): Set<string> => {
	const names = new Set<string>()
	for (const match of stripComments(source).matchAll(/var\(\s*(--[A-Za-z0-9_-]+)/g)) {
		const name = match[1]
		if (name !== undefined) names.add(name)
	}
	return names
}

const TAILWIND_PROVIDED: readonly string[] = [
	"--color-amber-400",
	"--color-amber-500",
	"--color-amber-700",
	"--color-blue-400",
	"--color-blue-500",
	"--color-blue-700",
	"--color-emerald-400",
	"--color-emerald-500",
	"--color-emerald-700",
	"--color-neutral-100",
	"--color-neutral-500",
	"--color-neutral-950",
	"--color-red-400",
	"--color-red-500",
	"--color-red-700",
	"--color-white",
	"--color-zinc-100",
	"--color-zinc-200",
	"--color-zinc-300",
	"--color-zinc-50",
	"--color-zinc-500",
	"--color-zinc-800",
	"--color-zinc-900",
]

const parseCustomProperties = (source: string): string[] => {
	const declarations: string[] = []
	const scopes: string[] = []
	let buffer = ""
	for (const character of stripComments(source)) {
		if (character === "{") {
			scopes.push(buffer.trim().replace(/\s+/g, " "))
			buffer = ""
			continue
		}
		if (character === "}" || character === ";") {
			if (character === "}") scopes.pop()
			const separator = buffer.indexOf(":")
			const name = separator === -1 ? "" : buffer.slice(0, separator).trim()
			if (name.startsWith("--")) {
				declarations.push(`${scopes.join(" > ")} ${name}: ${buffer.slice(separator + 1).trim()}`)
			}
			buffer = ""
			continue
		}
		buffer += character
	}
	return declarations.sort()
}

const PINNED_DECLARATIONS: readonly string[] = [
	":root --accent-foreground: var(--color-zinc-900)",
	":root --accent: var(--color-zinc-100)",
	":root --background: var(--color-zinc-25)",
	":root --border: var(--color-zinc-200)",
	":root --card-foreground: var(--color-zinc-800)",
	":root --card: var(--color-white)",
	":root --control-radius: 0.5rem",
	":root --destructive-foreground: var(--error-foreground)",
	":root --destructive: var(--error)",
	":root --error-foreground: var(--color-red-700)",
	":root --error-surface: color-mix(in srgb, var(--error) 8%, transparent)",
	":root --error: var(--color-red-500)",
	":root --foreground: var(--color-zinc-800)",
	":root --glass-blur: 12px",
	":root --glass-opacity: 80%",
	":root --glass-saturation: 1.14",
	":root --info-foreground: var(--color-blue-700)",
	":root --info: var(--color-blue-500)",
	":root --input: var(--color-zinc-300)",
	":root --muted-foreground: var(--color-zinc-500)",
	":root --muted: var(--color-zinc-50)",
	":root --popover-foreground: var(--color-zinc-800)",
	":root --popover: var(--color-white)",
	":root --primary-foreground: var(--color-white)",
	":root --primary: oklch(0.488 0.217 264)",
	":root --radius: 0.625rem",
	":root --ring: var(--primary)",
	":root --secondary-foreground: var(--color-zinc-800)",
	":root --secondary: var(--color-zinc-50)",
	":root --sidebar-border: var(--border)",
	":root --sidebar-content-inset: 0.5rem",
	":root --sidebar-foreground: var(--foreground)",
	":root --sidebar-muted-foreground: var(--muted-foreground)",
	":root --sidebar: var(--color-zinc-50)",
	":root --success-foreground: var(--color-emerald-700)",
	":root --success: var(--color-emerald-500)",
	":root --terminal-background: var(--background)",
	":root --terminal-cursor: rgb(38 56 78)",
	":root --terminal-foreground: var(--foreground)",
	":root --terminal-selection-background: rgb(37 63 99 / 20%)",
	":root --update-foreground: var(--primary)",
	":root --update-surface: color-mix(in srgb, var(--update) 12%, transparent)",
	":root --update: var(--primary)",
	":root --warning-foreground: var(--color-amber-700)",
	":root --warning-surface: color-mix(in srgb, var(--warning) 8%, transparent)",
	":root --warning: var(--color-amber-500)",
	":root > @variant dark --accent-foreground: var(--color-neutral-100)",
	":root > @variant dark --accent: --alpha(var(--color-white) / 4%)",
	":root > @variant dark --background: var(--color-neutral-950)",
	":root > @variant dark --border: --alpha(var(--color-white) / 6%)",
	":root > @variant dark --card-foreground: var(--color-neutral-100)",
	":root > @variant dark --card: color-mix(in srgb, var(--background) 97%, var(--color-white))",
	":root > @variant dark --error-foreground: var(--color-red-400)",
	":root > @variant dark --error-surface: color-mix(in srgb, var(--error) 16%, transparent)",
	":root > @variant dark --error: color-mix(in srgb, var(--color-red-500) 90%, var(--color-white))",
	":root > @variant dark --foreground: var(--color-neutral-100)",
	":root > @variant dark --glass-blur: 16px",
	":root > @variant dark --glass-saturation: 1.08",
	":root > @variant dark --info-foreground: var(--color-blue-400)",
	":root > @variant dark --input: --alpha(var(--color-white) / 8%)",
	":root > @variant dark --muted-foreground: color-mix(in srgb, var(--color-neutral-500) 90%, var(--color-white))",
	":root > @variant dark --muted: --alpha(var(--color-white) / 4%)",
	":root > @variant dark --popover-foreground: var(--color-neutral-100)",
	":root > @variant dark --popover: color-mix(in srgb, var(--background) 94%, var(--color-white))",
	":root > @variant dark --primary: oklch(0.571 0.21 264)",
	":root > @variant dark --secondary-foreground: var(--color-neutral-100)",
	":root > @variant dark --secondary: --alpha(var(--color-white) / 4%)",
	":root > @variant dark --sidebar: var(--card)",
	":root > @variant dark --success-foreground: var(--color-emerald-400)",
	":root > @variant dark --terminal-cursor: rgb(180 203 255)",
	":root > @variant dark --terminal-selection-background: rgb(180 203 255 / 25%)",
	":root > @variant dark --update-foreground: var(--color-blue-400)",
	":root > @variant dark --update-surface: color-mix(in srgb, var(--update) 18%, transparent)",
	":root > @variant dark --warning-foreground: var(--color-amber-400)",
	":root > @variant dark --warning-surface: color-mix(in srgb, var(--warning) 16%, transparent)",
	'@theme --font-mono: ui-monospace, "SF Mono", "SFMono-Regular", Menlo, Consolas, "Liberation Mono", monospace',
	'@theme --font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
	"@theme inline --color-accent-foreground: var(--accent-foreground)",
	"@theme inline --color-accent: var(--accent)",
	"@theme inline --color-background: var(--background)",
	"@theme inline --color-border: var(--border)",
	"@theme inline --color-card-foreground: var(--card-foreground)",
	"@theme inline --color-card: var(--card)",
	"@theme inline --color-destructive-foreground: var(--destructive-foreground)",
	"@theme inline --color-destructive: var(--destructive)",
	"@theme inline --color-error-foreground: var(--error-foreground)",
	"@theme inline --color-error-surface: var(--error-surface)",
	"@theme inline --color-error: var(--error)",
	"@theme inline --color-foreground: var(--foreground)",
	"@theme inline --color-info-foreground: var(--info-foreground)",
	"@theme inline --color-info: var(--info)",
	"@theme inline --color-input: var(--input)",
	"@theme inline --color-muted-foreground: var(--muted-foreground)",
	"@theme inline --color-muted: var(--muted)",
	"@theme inline --color-popover-foreground: var(--popover-foreground)",
	"@theme inline --color-popover: var(--popover)",
	"@theme inline --color-primary-foreground: var(--primary-foreground)",
	"@theme inline --color-primary: var(--primary)",
	"@theme inline --color-ring: var(--ring)",
	"@theme inline --color-secondary-foreground: var(--secondary-foreground)",
	"@theme inline --color-secondary: var(--secondary)",
	"@theme inline --color-sidebar-border: var(--sidebar-border)",
	"@theme inline --color-sidebar-foreground: var(--sidebar-foreground)",
	"@theme inline --color-sidebar-muted-foreground: var(--sidebar-muted-foreground)",
	"@theme inline --color-sidebar: var(--sidebar)",
	"@theme inline --color-success-foreground: var(--success-foreground)",
	"@theme inline --color-success: var(--success)",
	"@theme inline --color-update-foreground: var(--update-foreground)",
	"@theme inline --color-update-surface: var(--update-surface)",
	"@theme inline --color-update: var(--update)",
	"@theme inline --color-warning-foreground: var(--warning-foreground)",
	"@theme inline --color-warning-surface: var(--warning-surface)",
	"@theme inline --color-warning: var(--warning)",
	"@theme inline --color-zinc-25: oklch(99.2% 0 0)",
	"@theme inline --radius-2xl: calc(var(--radius) + 8px)",
	"@theme inline --radius-lg: var(--radius)",
	"@theme inline --radius-md: calc(var(--radius) - 2px)",
	"@theme inline --radius-sm: calc(var(--radius) - 4px)",
	"@theme inline --radius-xl: calc(var(--radius) + 4px)",
]

describe("design tokens mirrored from the reference", () => {
	it("pins the scope, name and value of every custom property the stylesheet declares", () => {
		expect(parseCustomProperties(css)).toEqual(PINNED_DECLARATIONS)
	})

	it("uses the tailwind v4 dark variant rather than a media query only", () => {
		expect(css).toContain("@custom-variant dark")
	})

	it("parses a declaration that has a comment above it, so documenting a token cannot unpin it", () => {
		const documented = [
			":root {",
			"\t--alpha: 1px;",
			"\t/* Keep this in the same family as the sidebar. */",
			"\t--beta: 2px;",
			"}",
		].join("\n")

		expect(parseCustomProperties(documented)).toEqual([":root --alpha: 1px", ":root --beta: 2px"])
	})

	it("keeps a comment that precedes a block out of the scope the block opens", () => {
		const documented = "/* the tokens the dashboard reads */\n:root {\n\t--alpha: 1px;\n}"

		expect(parseCustomProperties(documented)).toEqual([":root --alpha: 1px"])
	})

	it("pins one declaration per name and scope, so a token declared in both themes is one name and two declarations", () => {
		expect(parseCustomProperties(css)).toHaveLength(PINNED_DECLARATIONS.length)
		expect(declaredNames(css).size).toBeLessThan(PINNED_DECLARATIONS.length)
	})

	it("resolves every var() to a property this stylesheet declares or Tailwind provides, so a typo cannot render as nothing", () => {
		const declared = declaredNames(css)
		const provided = new Set(TAILWIND_PROVIDED)
		const unresolved = [...referencedNames(css)]
			.filter((name) => !declared.has(name) && !provided.has(name))
			.sort()

		expect(
			unresolved,
			`${unresolved.join(", ")} is referenced by var() but is neither declared in index.css nor listed in TAILWIND_PROVIDED as a colour Tailwind supplies`,
		).toEqual([])
	})
})
