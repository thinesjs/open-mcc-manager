import { describe, expect, it } from "vitest"
import { EXEMPT_ROUTES, findViolations } from "./check-page-loading.mjs"

const label = "apps/web/src/routes/_authenticated.hosts.index.tsx"

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
