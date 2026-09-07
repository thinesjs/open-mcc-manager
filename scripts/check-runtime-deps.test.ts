import { describe, expect, it } from "vitest"
import { externalsIn, missing, shippedIn } from "./check-runtime-deps.mjs"

describe("reading what a Dockerfile keeps out of the bundle", () => {
	it("finds every external", () => {
		const found = externalsIn("RUN esbuild --external:pg --external:zod --outfile=x.mjs")
		expect([...found].sort()).toEqual(["pg", "zod"])
	})

	it("reduces a subpath pattern to the package that must ship", () => {
		expect([...externalsIn("--external:hono/*")]).toEqual(["hono"])
	})

	it("is not confused by a line continuation", () => {
		expect([...externalsIn("--external:pg \\\n\t--external:zod")].sort()).toEqual(["pg", "zod"])
	})
})

describe("reading what the prune script keeps", () => {
	it("finds the allowlist", () => {
		const shipped = shippedIn('const runtimeRoots = [\n\t"pg",\n\t"zod",\n]\nconst other = ["no"]')
		expect([...shipped].sort()).toEqual(["pg", "zod"])
	})
})

describe("catching the mismatch that shipped a broken image", () => {
	it("names a package that is externalised but would be deleted", () => {
		expect(missing(new Set(["pg", "undici"]), new Set(["pg"]))).toEqual(["undici"])
	})

	it("says nothing when every external is kept", () => {
		expect(missing(new Set(["pg"]), new Set(["pg", "zod"]))).toEqual([])
	})
})
