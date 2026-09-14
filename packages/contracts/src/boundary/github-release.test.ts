import { describe, expect, it } from "vitest"
import { parseLatestRelease } from "./github-release"

describe("reading GitHub's answer about a repository's latest release", () => {
	it("reads the tag and the notes", () => {
		expect(parseLatestRelease(JSON.stringify({ tag_name: "v1.5.0", body: "## Fixes" }))).toEqual({
			tagName: "v1.5.0",
			body: "## Fixes",
		})
	})

	it("reads a release with no notes as having none", () => {
		expect(parseLatestRelease(JSON.stringify({ tag_name: "v1.5.0", body: null }))?.body).toBeNull()
		expect(parseLatestRelease(JSON.stringify({ tag_name: "v1.5.0" }))?.body).toBeNull()
	})

	it("keeps nothing from the answer but the tag and the notes, so no address it names survives", () => {
		const parsed = parseLatestRelease(
			JSON.stringify({
				tag_name: "v1.5.0",
				body: "",
				html_url: "https://evil.example/release",
				assets: [{ browser_download_url: "https://evil.example/asset" }],
			}),
		)

		expect(Object.keys(parsed ?? {}).sort()).toEqual(["body", "tagName"])
	})

	it("refuses an answer with no tag, or a tag that is not text", () => {
		expect(parseLatestRelease(JSON.stringify({ body: "notes" }))).toBeUndefined()
		expect(parseLatestRelease(JSON.stringify({ tag_name: 150, body: "notes" }))).toBeUndefined()
	})

	it("refuses notes that are not text", () => {
		expect(parseLatestRelease(JSON.stringify({ tag_name: "v1.5.0", body: 5 }))).toBeUndefined()
	})

	it("refuses an answer that is not an object", () => {
		for (const raw of ["[]", "null", '"v1.5.0"']) {
			expect(parseLatestRelease(raw), raw).toBeUndefined()
		}
	})

	it("refuses an answer that is not JSON", () => {
		expect(parseLatestRelease("<html>rate limited</html>")).toBeUndefined()
	})
})
