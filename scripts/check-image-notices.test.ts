import { describe, expect, it } from "vitest"
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
