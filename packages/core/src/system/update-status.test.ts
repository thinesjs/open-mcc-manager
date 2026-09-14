import type { UpdateStateRow } from "@open-mcc/db"
import { describe, expect, it } from "vitest"
import type { BuildInfo } from "./build-info"
import { RELEASE_NOTE_MAX_BLOCKS } from "./release-notes"
import { releaseNotesFor, updateStatusFor } from "./update-status"

const RELEASE_BUILD: BuildInfo = { version: "1.4.0", commit: "abc123def456" }

const CHECKED_AT = new Date("2026-09-13T12:41:00Z")

const row = (patch: Partial<UpdateStateRow> = {}): UpdateStateRow => ({
	id: "singleton",
	sourceOwner: "thinesjs",
	sourceRepo: "open-mcc-manager",
	checkedAt: CHECKED_AT,
	checkOutcome: "ok",
	rateLimitedUntil: null,
	latestVersion: "1.5.0",
	latestNotes: "## Fixes\n- one",
	notesTruncated: false,
	...patch,
})

describe("what the deployment reports about updates", () => {
	it("reports a development build as one, whatever the last check found", () => {
		for (const build of [
			{ version: "0.0.0-dev", commit: "abc123def456" },
			{ version: "1.4.0", commit: "unknown" },
		]) {
			expect(updateStatusFor(build, row())).toEqual({ kind: "development" })
		}
	})

	it("reports that nothing has been checked yet", () => {
		expect(updateStatusFor(RELEASE_BUILD, undefined)).toEqual({
			kind: "unchecked",
			running: "1.4.0",
		})
	})

	it("offers a newer release, with its times as text the dashboard can read", () => {
		expect(updateStatusFor(RELEASE_BUILD, row())).toEqual({
			kind: "checked",
			running: "1.4.0",
			latest: "1.5.0",
			available: true,
			checkedAt: "2026-09-13T12:41:00.000Z",
			outcome: "ok",
			rateLimitedUntil: null,
			source: { owner: "thinesjs", repo: "open-mcc-manager" },
		})
	})

	it("does not offer an older release, even one the source calls its latest", () => {
		const status = updateStatusFor(RELEASE_BUILD, row({ latestVersion: "1.3.9" }))

		expect(status.kind === "checked" && status.available).toBe(false)
		expect(status.kind === "checked" && status.latest).toBe("1.3.9")
	})

	it("does not offer the release that is already running", () => {
		const status = updateStatusFor(RELEASE_BUILD, row({ latestVersion: "1.4.0" }))

		expect(status.kind === "checked" && status.available).toBe(false)
	})

	it("keeps offering the release it found when a later check failed, and says the check failed", () => {
		const status = updateStatusFor(
			RELEASE_BUILD,
			row({ checkOutcome: "rate-limited", rateLimitedUntil: new Date("2026-09-13T13:00:00Z") }),
		)

		expect(status).toMatchObject({
			kind: "checked",
			available: true,
			outcome: "rate-limited",
			rateLimitedUntil: "2026-09-13T13:00:00.000Z",
		})
	})

	it("ignores a stored version that is not a release version", () => {
		const status = updateStatusFor(RELEASE_BUILD, row({ latestVersion: "99.0.0-evil" }))

		expect(status).toMatchObject({ kind: "checked", latest: null, available: false })
	})

	it("never hands the dashboard a stored source it would not ask", () => {
		const status = updateStatusFor(RELEASE_BUILD, row({ sourceOwner: "evil.example/x" }))

		expect(status).toMatchObject({ kind: "checked", source: null })
	})
})

describe("the release notes the dashboard is given", () => {
	it("reads the notes of an available release into blocks, with where they came from", () => {
		expect(releaseNotesFor(RELEASE_BUILD, row())).toEqual({
			version: "1.5.0",
			source: { owner: "thinesjs", repo: "open-mcc-manager" },
			blocks: [
				{ kind: "heading", spans: [{ kind: "text", text: "Fixes" }] },
				{ kind: "bullet", spans: [{ kind: "text", text: "one" }] },
			],
			truncated: false,
		})
	})

	it("says the notes were cut when the check cut them", () => {
		expect(releaseNotesFor(RELEASE_BUILD, row({ notesTruncated: true }))?.truncated).toBe(true)
	})

	it("says the notes were cut when there were too many blocks to show", () => {
		const many = Array.from({ length: RELEASE_NOTE_MAX_BLOCKS + 1 }, () => "- item").join("\n")

		expect(releaseNotesFor(RELEASE_BUILD, row({ latestNotes: many }))?.truncated).toBe(true)
	})

	it("gives an available release with no notes an empty set of blocks", () => {
		expect(releaseNotesFor(RELEASE_BUILD, row({ latestNotes: null }))?.blocks).toEqual([])
	})

	it("gives no notes for a release that is not newer", () => {
		expect(releaseNotesFor(RELEASE_BUILD, row({ latestVersion: "1.3.9" }))).toBeNull()
	})

	it("gives no notes to a development build", () => {
		expect(releaseNotesFor({ version: "0.0.0-dev", commit: "unknown" }, row())).toBeNull()
	})

	it("gives no notes before anything has been checked", () => {
		expect(releaseNotesFor(RELEASE_BUILD, undefined)).toBeNull()
	})
})
