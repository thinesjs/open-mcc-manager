import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, describe, expect, it } from "vitest"
import { externalsIn, missing, shippedIn } from "./check-runtime-deps.mjs"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

const CHECKER = join(ROOT, "scripts", "check-runtime-deps.mjs")

const SPAWN_TIMEOUT_MS = 60_000

const made: string[] = []

afterAll(() => {
	for (const directory of made) rmSync(directory, { recursive: true, force: true })
})

const seeded = (files: Record<string, string>): string => {
	const root = mkdtempSync(join(tmpdir(), "a runtime-deps-"))
	made.push(root)
	for (const [path, source] of Object.entries(files)) {
		const full = join(root, path)
		mkdirSync(dirname(full), { recursive: true })
		writeFileSync(full, source)
	}
	return root
}

const run = (cwd: string): { status: number | null; output: string } => {
	const result = spawnSync("node", [CHECKER], { cwd, encoding: "utf8" })
	return { status: result.status, output: `${result.stdout}${result.stderr}` }
}

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

describe("the command pnpm lint runs", () => {
	it(
		"exits 0 on the tree as it stands",
		() => {
			const { status, output } = run(ROOT)

			expect(output).toBe("")
			expect(status).toBe(0)
		},
		SPAWN_TIMEOUT_MS,
	)

	it(
		"★ exits 1 naming the external the prune step would delete, so a gutted body is caught",
		() => {
			const root = seeded({
				"docker/server/Dockerfile":
					"RUN esbuild --external:pg --external:undici --outfile=server.mjs\n",
				"docker/worker/Dockerfile": "RUN esbuild --external:pg --outfile=worker.mjs\n",
				"docker/web/Dockerfile": "RUN esbuild --outfile=web.mjs\n",
				"docker/server/prune-deploy.mjs": 'const runtimeRoots = [\n\t"pg",\n]\n',
			})

			const { status, output } = run(root)

			expect(status).toBe(1)
			expect(output).toContain(
				"docker/server/Dockerfile marks undici external, but docker/server/prune-deploy.mjs would delete it",
			)
		},
		SPAWN_TIMEOUT_MS,
	)

	it(
		"★ exits 1 naming an external the wholly-bundled image has no node_modules to resolve",
		() => {
			const root = seeded({
				"docker/server/Dockerfile": "RUN esbuild --external:pg --outfile=server.mjs\n",
				"docker/worker/Dockerfile": "RUN esbuild --external:pg --outfile=worker.mjs\n",
				"docker/web/Dockerfile": "RUN esbuild --external:hono --outfile=web.mjs\n",
				"docker/server/prune-deploy.mjs": 'const runtimeRoots = [\n\t"pg",\n]\n',
			})

			const { status, output } = run(root)

			expect(status).toBe(1)
			expect(output).toContain(
				"docker/web/Dockerfile marks hono external, but that image ships no node_modules to resolve it from",
			)
		},
		SPAWN_TIMEOUT_MS,
	)
})
