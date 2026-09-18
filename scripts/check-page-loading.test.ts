import { spawnSync } from "node:child_process"
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, describe, expect, it } from "vitest"
import { EXEMPT_ROUTES, findViolations } from "./check-page-loading.mjs"

const label = "apps/web/src/routes/_authenticated.hosts.index.tsx"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

const CHECKER = join(ROOT, "scripts", "check-page-loading.mjs")

const SPAWN_TIMEOUT_MS = 60_000

const made: string[] = []

afterAll(() => {
	for (const directory of made) rmSync(directory, { recursive: true, force: true })
})

const seeded = (files: Record<string, string>): string => {
	const root = mkdtempSync(join(tmpdir(), "a page-loading-"))
	made.push(root)
	mkdirSync(join(root, "scripts"), { recursive: true })
	copyFileSync(CHECKER, join(root, "scripts", "check-page-loading.mjs"))
	for (const [path, source] of Object.entries(files)) {
		const full = join(root, "apps", "web", "src", "routes", path)
		mkdirSync(dirname(full), { recursive: true })
		writeFileSync(full, source)
	}
	return root
}

const run = (script: string): { status: number | null; output: string } => {
	const result = spawnSync("node", [script], { encoding: "utf8" })
	return { status: result.status, output: `${result.stdout}${result.stderr}` }
}

describe("loading UI a route renders for itself", () => {
	it("flags a route that imports the shared loading block", () => {
		const source = 'import { LoadingBlock } from "~/components/ui/spinner"\n'
		expect(findViolations(source, label).length).toBeGreaterThan(0)
	})

	it("flags a route that imports the spinner", () => {
		const source = 'import { Spinner } from "~/components/ui/spinner"\n'
		expect(findViolations(source, label).length).toBeGreaterThan(0)
	})

	it("flags a route that reaches for the page shimmer directly", () => {
		const source = 'import { PageShimmer } from "~/components/ui/index"\n'
		expect(findViolations(source, label)).toHaveLength(1)
	})

	it("flags a route that reaches for the labelled page loading block directly", () => {
		const source = 'import { PageLoading } from "~/components/ui/index"\n'
		expect(findViolations(source, label)).toHaveLength(1)
	})

	it("flags a renamed import, since the rendered element is the same one", () => {
		const source = 'import { Spinner as Busy } from "~/x"\n'
		expect(findViolations(source, label)).toHaveLength(1)
	})

	it("flags a namespace import of the module, which no named binding would reveal", () => {
		const source = 'import * as Busy from "~/components/ui/spinner"\n'
		expect(findViolations(source, label)).toHaveLength(1)
	})

	it("flags a default import of the module", () => {
		const source = 'import Busy from "~/components/ui/shimmer"\n'
		expect(findViolations(source, label)).toHaveLength(1)
	})

	it("flags a specifier written with its file extension, which the bundler resolves the same", () => {
		const source = 'import * as Busy from "~/components/ui/shimmer.tsx"\n'
		expect(findViolations(source, label)).toHaveLength(1)
	})

	it("flags a dynamic import of the module, which no static binding would reveal", () => {
		const source = 'const { Spinner: S } = await import("~/components/ui/spinner")\n'
		expect(findViolations(source, label).length).toBeGreaterThan(0)
	})

	it("flags the name however it reaches the route, not only from the loading modules", () => {
		const source = 'import { Spinner } from "~/components/ui/index"\n'
		expect(findViolations(source, label)).toHaveLength(1)
	})

	it("accepts a route that takes its loading state from the boundary", () => {
		const source = [
			'import { useSuspenseQuery } from "@tanstack/react-query"',
			'import { Button } from "~/components/ui/button"',
			"",
		].join("\n")
		expect(findViolations(source, label)).toEqual([])
	})

	it("is not fooled by the word appearing in copy rather than an import", () => {
		const source = '<p className="text-sm">Spinner</p>\n'
		expect(findViolations(source, label)).toEqual([])
	})

	it("names the file, the line and what to do instead", () => {
		const source = [
			'import { Button } from "~/components/ui/button"',
			'import { Spinner } from "~/x"',
		].join("\n")
		const [first] = findViolations(source, label)
		expect(first).toContain(`${label}:2`)
		expect(first).toContain("useSuspenseQuery")
		expect(first).toContain("apps/web/src/components/")
	})

	it("exempts two routes by exact path, each with its reason, so the hole cannot widen unnoticed", () => {
		expect([...EXEMPT_ROUTES.keys()]).toEqual(["_authenticated.tsx", "_authenticated.audit.tsx"])
		for (const reason of EXEMPT_ROUTES.values()) expect(reason.length).toBeGreaterThan(20)
	})
})

describe("the command pnpm lint runs", () => {
	it(
		"exits 0 on the tree as it stands",
		() => {
			const { status, output } = run(CHECKER)

			expect(output).toBe("")
			expect(status).toBe(0)
		},
		SPAWN_TIMEOUT_MS,
	)

	it(
		"★ exits 1 naming the route and line that renders its own wait, so a gutted body is caught",
		() => {
			const root = seeded({
				"_authenticated.hosts.index.tsx":
					'import { Spinner } from "~/components/ui/spinner"\n\nexport const Route = { component: Spinner }\n',
			})

			const { status, output } = run(join(root, "scripts", "check-page-loading.mjs"))

			expect(status).toBe(1)
			expect(output).toContain(
				`${join("apps", "web", "src", "routes", "_authenticated.hosts.index.tsx")}:1 a route imports Spinner`,
			)
			expect(output).toContain("useSuspenseQuery")
		},
		SPAWN_TIMEOUT_MS,
	)
})
