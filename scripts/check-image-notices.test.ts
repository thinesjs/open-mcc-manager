import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, describe, expect, it } from "vitest"
import {
	carriesNotices,
	generatesNotices,
	problemsFor,
	publishedImages,
	stagesOf,
} from "./check-image-notices.mjs"

const WORKFLOW = `        include:
          - image: open-mcc-server
            dockerfile: docker/server/Dockerfile
            target: runtime
          - image: open-mcc-migrate
            dockerfile: docker/server/Dockerfile
            target: migrate
`

const DOCKERFILE = `FROM node:22 AS build
RUN node third-party-notices.mjs /app /out /notices/THIRD-PARTY-NOTICES.txt meta.json

FROM base AS runtime
COPY --from=build /out /app
COPY --from=build /notices/THIRD-PARTY-NOTICES.txt /licenses/THIRD-PARTY-NOTICES.txt
CMD ["server.mjs"]
`

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

const CHECKER = join(ROOT, "scripts", "check-image-notices.mjs")

const SPAWN_TIMEOUT_MS = 60_000

const made: string[] = []

afterAll(() => {
	for (const directory of made) rmSync(directory, { recursive: true, force: true })
})

const seeded = (files: Record<string, string>): string => {
	const root = mkdtempSync(join(tmpdir(), "a image-notices-"))
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

describe("reading what the release workflow publishes", () => {
	it("pairs every published image with its dockerfile and target", () => {
		expect(publishedImages(WORKFLOW)).toEqual([
			{ image: "open-mcc-server", dockerfile: "docker/server/Dockerfile", target: "runtime" },
			{ image: "open-mcc-migrate", dockerfile: "docker/server/Dockerfile", target: "migrate" },
		])
	})
})

describe("reading a multi-stage Dockerfile", () => {
	it("attributes each line to the stage it belongs to", () => {
		const stages = stagesOf(DOCKERFILE)
		expect([...stages.keys()]).toEqual(["build", "runtime"])
		expect(stages.get("build")).toContain("third-party-notices.mjs")
		expect(stages.get("build")).not.toContain("/licenses/")
	})
})

describe("recognising the notice bundle", () => {
	it("sees the build stage generate it", () => {
		expect(generatesNotices(DOCKERFILE)).toBe(true)
	})

	it("sees an image stage copy it in", () => {
		expect(carriesNotices("COPY --from=build /a /licenses/THIRD-PARTY-NOTICES.txt")).toBe(true)
	})

	it("is not satisfied by a stage that merely mentions the path", () => {
		expect(carriesNotices("RUN cat /licenses/THIRD-PARTY-NOTICES.txt")).toBe(false)
	})

	it("★ is not satisfied by a dockerfile that only copies the generator in", () => {
		const copied = [
			"FROM node:22 AS build",
			"RUN corepack enable",
			"COPY docker/third-party-notices.mjs ./third-party-notices.mjs",
			"RUN pnpm install",
		].join("\n")

		expect(generatesNotices(copied)).toBe(false)
	})

	it("★ is not satisfied by a RUN that only names the generator without running it", () => {
		const named = ["FROM node:22 AS build", "RUN echo third-party-notices.mjs"].join("\n")

		expect(generatesNotices(named)).toBe(false)
	})

	it("★ sees a generator run that was wrapped onto a second line", () => {
		const wrapped = ["FROM node:22 AS build", "RUN node \\", "\tthird-party-notices.mjs /app"].join(
			"\n",
		)

		expect(generatesNotices(wrapped)).toBe(true)
	})
})

describe("catching an image that would publish without its notices", () => {
	const published = {
		image: "open-mcc-server",
		dockerfile: "docker/server/Dockerfile",
		target: "runtime",
	}

	it("says nothing when the stage generates and carries the bundle", () => {
		expect(problemsFor(published, DOCKERFILE)).toEqual([])
	})

	it("names the stage that does not copy the bundle in", () => {
		const stripped = DOCKERFILE.split("\n")
			.filter((line) => !line.includes("/licenses/"))
			.join("\n")
		expect(problemsFor(published, stripped)).toEqual([
			"docker/server/Dockerfile stage runtime does not copy /licenses/THIRD-PARTY-NOTICES.txt into the image",
		])
	})

	it("names a dockerfile that never generates the bundle", () => {
		const stripped = DOCKERFILE.split("\n")
			.filter((line) => !line.includes("third-party-notices.mjs"))
			.join("\n")
		expect(problemsFor(published, stripped)).toEqual([
			"docker/server/Dockerfile never runs third-party-notices.mjs",
		])
	})

	it("names a published target no stage answers to", () => {
		expect(problemsFor({ ...published, target: "gone" }, DOCKERFILE)).toEqual([
			"docker/server/Dockerfile has no stage named gone",
		])
	})

	it("rejects a published image that names no dockerfile", () => {
		expect(problemsFor({ image: "open-mcc-web", dockerfile: "", target: "" }, "")).toEqual([
			".github/workflows/release.yml publishes open-mcc-web without naming a dockerfile and a target",
		])
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
		"★ exits 1 naming the stage that would ship without the notices, so a gutted body is caught",
		() => {
			const root = seeded({
				".github/workflows/release.yml": WORKFLOW,
				"docker/server/Dockerfile": DOCKERFILE.split("\n")
					.filter((line) => !line.includes("/licenses/"))
					.join("\n"),
			})

			const { status, output } = run(root)

			expect(status).toBe(1)
			expect(output).toContain(
				"docker/server/Dockerfile stage runtime does not copy /licenses/THIRD-PARTY-NOTICES.txt into the image",
			)
		},
		SPAWN_TIMEOUT_MS,
	)
})
