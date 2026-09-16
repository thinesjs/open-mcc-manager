import { describe, expect, it } from "vitest"
import { AWAITING_ANOTHER_BRANCH, findViolations } from "./check-page-loading.mjs"

const label = "apps/web/src/routes/_authenticated.hosts.index.tsx"

describe("loading UI a route renders for itself", () => {
	it("flags a route that imports the shared loading block", () => {
		const source = 'import { LoadingBlock } from "~/components/ui/spinner"\n'
		expect(findViolations(source, label)).toHaveLength(1)
	})

	it("flags a route that imports the spinner", () => {
		const source = 'import { Spinner } from "~/components/ui/spinner"\n'
		expect(findViolations(source, label)).toHaveLength(1)
	})

	it("flags both names when a route imports them together", () => {
		const source = 'import { LoadingBlock, Spinner } from "~/components/ui/spinner"\n'
		expect(findViolations(source, label)).toHaveLength(2)
	})

	it("flags a renamed import, since the rendered element is the same one", () => {
		const source = 'import { Spinner as Busy } from "~/components/ui/spinner"\n'
		expect(findViolations(source, label)).toHaveLength(1)
	})

	it("flags the name however it reaches the route, not only from the spinner module", () => {
		const source = 'import { Spinner } from "~/components/ui/index"\n'
		expect(findViolations(source, label)).toHaveLength(1)
	})

	it("accepts a route that takes its loading state from the boundary", () => {
		const source = [
			'import { useSuspenseQuery } from "@tanstack/react-query"',
			'import { PageShimmer } from "~/components/ui/shimmer"',
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

	it("exempts one route by exact path and no other, so the hole cannot widen unnoticed", () => {
		expect([...AWAITING_ANOTHER_BRANCH]).toEqual(["_authenticated.instances.$instanceId.tsx"])
	})
})
