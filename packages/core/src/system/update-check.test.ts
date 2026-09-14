import { PROJECT_SOURCE, type UpdateSource } from "@open-mcc/contracts"
import type { UpdateStateRow } from "@open-mcc/db"
import { errors } from "undici"
import { describe, expect, it } from "vitest"
import { createLogger } from "../log/logger"
import { byteLength } from "../notification/bounds"
import type { PinnedResult } from "../notification/pinned"
import type { BuildInfo } from "./build-info"
import {
	checkFailureOf,
	createUpdateCheck,
	latestReleaseUrl,
	RELEASE_NOTES_MAX_BYTES,
	readReleaseAnswer,
	shouldCheckAtBoot,
	UPDATE_CHECK_INTERVAL_MS,
	updateCheckReporter,
} from "./update-check"
import type { UpdateCheckResult } from "./update-state.repository"

const NOW = new Date("2026-09-13T12:41:00Z")

const RELEASE_BUILD: BuildInfo = { version: "1.4.0", commit: "abc123def456" }

const answered = (
	status: number,
	body: string,
	headers: Record<string, string> = {},
): PinnedResult => ({ sent: true, status, headers, body })

const release = (tag: string, body: string | null = "## Fixes") =>
	answered(200, JSON.stringify({ tag_name: tag, body }))

const recordedRow = (patch: Partial<UpdateStateRow>): UpdateStateRow => ({
	id: "singleton",
	sourceOwner: "thinesjs",
	sourceRepo: "open-mcc-manager",
	checkedAt: new Date(NOW.getTime() - 7 * 60 * 60 * 1000),
	checkOutcome: "ok",
	rateLimitedUntil: null,
	latestVersion: "1.4.0",
	latestNotes: null,
	notesTruncated: false,
	...patch,
})

type Recorded = { source: UpdateSource; checkedAt: Date; result: UpdateCheckResult }

const harness = (
	options: { build?: BuildInfo; row?: UpdateStateRow; answer?: () => Promise<PinnedResult> } = {},
) => {
	const asked: string[] = []
	const recorded: Recorded[] = []
	const answer = options.answer ?? (async () => release("v1.5.0"))
	const check = createUpdateCheck({
		build: options.build ?? RELEASE_BUILD,
		readState: async () => options.row,
		request: async (url) => {
			asked.push(url)
			return await answer()
		},
		record: async (source, checkedAt, result) => {
			recorded.push({ source, checkedAt, result })
		},
		now: () => NOW,
	})
	return { check, asked, recorded }
}

describe("where the release check asks", () => {
	it("puts the owner and repository into GitHub's releases path and nowhere else", () => {
		expect(latestReleaseUrl({ owner: "some-owner", repo: "a.repo_name" })).toBe(
			"https://api.github.com/repos/some-owner/a.repo_name/releases/latest",
		)
	})

	it("asks the project's own repository before any check has been recorded", async () => {
		const { check, asked } = harness()
		await check()

		expect(asked).toEqual([
			"https://api.github.com/repos/thinesjs/open-mcc-manager/releases/latest",
		])
	})

	it("asks the repository the deployment has recorded", async () => {
		const { check, asked } = harness({
			row: recordedRow({ sourceOwner: "someone", sourceRepo: "fork" }),
		})
		await check()

		expect(asked).toEqual(["https://api.github.com/repos/someone/fork/releases/latest"])
	})

	it("sends nothing when the recorded source is not a repository name it will ask", async () => {
		const { check, asked, recorded } = harness({
			row: recordedRow({ sourceOwner: "evil.example/x" }),
		})

		expect(await check()).toEqual({ checked: false, reason: "unusable-source" })
		expect(asked).toEqual([])
		expect(recorded).toEqual([])
	})
})

describe("a job that runs soon after the last check", () => {
	const checkedAgo = (ms: number) => recordedRow({ checkedAt: new Date(NOW.getTime() - ms) })

	it("asks nothing when the last check is younger than half the poll, so a duplicate job costs no request", async () => {
		const row = checkedAgo(UPDATE_CHECK_INTERVAL_MS / 2 - 60_000)
		const { check, asked, recorded } = harness({ row })

		expect(await check()).toEqual({ checked: false, reason: "recent" })
		expect(asked).toEqual([])
		expect(recorded).toEqual([])
	})

	it("asks again once the last check is half the poll old", async () => {
		const { check, asked } = harness({ row: checkedAgo(UPDATE_CHECK_INTERVAL_MS / 2) })

		expect(await check()).toEqual({ checked: true, outcome: "ok" })
		expect(asked).toHaveLength(1)
	})
})

describe("a development build", () => {
	it("never asks GitHub, whether the version or the commit gives it away", async () => {
		for (const build of [
			{ version: "0.0.0-dev", commit: "abc123def456" },
			{ version: "1.4.0", commit: "unknown" },
		]) {
			const { check, asked, recorded } = harness({ build })

			expect(await check()).toEqual({ checked: false, reason: "development" })
			expect(asked).toEqual([])
			expect(recorded).toEqual([])
		}
	})

	it("is the only thing that stops a release build asking", async () => {
		const { check, asked } = harness({ build: RELEASE_BUILD })

		expect(await check()).toEqual({ checked: true, outcome: "ok" })
		expect(asked).toHaveLength(1)
	})
})

describe("reading GitHub's answer", () => {
	it("reads the version from a v-prefixed tag, with its notes", () => {
		expect(readReleaseAnswer(release("v1.5.0", "## Fixes"), NOW)).toEqual({
			outcome: "ok",
			release: { version: "1.5.0", notes: "## Fixes", notesTruncated: false },
		})
	})

	it("reads a release with blank notes as having none", () => {
		for (const body of ["", "  \n\t", null]) {
			expect(readReleaseAnswer(release("v1.5.0", body), NOW)).toEqual({
				outcome: "ok",
				release: { version: "1.5.0", notes: null, notesTruncated: false },
			})
		}
	})

	it("still reads the version from a release whose notes are too long, and cuts the notes short", () => {
		const long = "a".repeat(RELEASE_NOTES_MAX_BYTES + 5_000)
		const result = readReleaseAnswer(release("v1.5.0", long), NOW)

		expect(result.outcome).toBe("ok")
		if (result.outcome !== "ok") return
		expect(result.release.version).toBe("1.5.0")
		expect(result.release.notesTruncated).toBe(true)
		expect(byteLength(result.release.notes ?? "")).toBeLessThanOrEqual(RELEASE_NOTES_MAX_BYTES)
		expect(result.release.notes?.startsWith("aaaa")).toBe(true)
	})

	it("keeps notes that fill the limit exactly as they were written", () => {
		const exact = "é".repeat(RELEASE_NOTES_MAX_BYTES / 2)
		expect(byteLength(exact)).toBe(RELEASE_NOTES_MAX_BYTES)

		expect(readReleaseAnswer(release("v1.5.0", exact), NOW)).toEqual({
			outcome: "ok",
			release: { version: "1.5.0", notes: exact, notesTruncated: false },
		})
	})

	it("refuses a tag that is not a v and a release version", () => {
		for (const tag of ["1.5.0", "v1.5", "v1.5.0-rc.1", "release-1.5.0", "v01.5.0", "V1.5.0"]) {
			expect(readReleaseAnswer(release(tag), NOW), tag).toEqual({ outcome: "unreadable" })
		}
	})

	it("reads an answer that is not a release as unreadable", () => {
		expect(readReleaseAnswer(answered(200, "<html>hello</html>"), NOW)).toEqual({
			outcome: "unreadable",
		})
	})

	it("reads a moved repository as not found rather than following it", () => {
		const moved = answered(301, "", {
			location: "https://api.github.com/repositories/1/releases/latest",
		})

		expect(readReleaseAnswer(moved, NOW)).toEqual({ outcome: "not-found" })
	})

	it("reads a repository with no published release as not found", () => {
		expect(readReleaseAnswer(answered(404, '{"message":"Not Found"}'), NOW)).toEqual({
			outcome: "not-found",
		})
	})

	it("reads GitHub's rate limit and when it ends", () => {
		const reset = Math.floor(NOW.getTime() / 1000) + 900
		const limited = answered(403, "", {
			"x-ratelimit-remaining": "0",
			"x-ratelimit-reset": String(reset),
		})

		expect(readReleaseAnswer(limited, NOW)).toEqual({
			outcome: "rate-limited",
			until: new Date(reset * 1000),
		})
	})

	it("reads a rate limit that only says how long to wait", () => {
		expect(readReleaseAnswer(answered(429, "", { "retry-after": "120" }), NOW)).toEqual({
			outcome: "rate-limited",
			until: new Date(NOW.getTime() + 120_000),
		})
	})

	it("reads a rate limit with no usable end as a rate limit all the same", () => {
		expect(readReleaseAnswer(answered(429, ""), NOW)).toEqual({
			outcome: "rate-limited",
			until: null,
		})
		const vague = answered(403, "", { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "soon" })
		expect(readReleaseAnswer(vague, NOW)).toEqual({ outcome: "rate-limited", until: null })
	})

	it("does not read an ordinary refusal as a rate limit", () => {
		expect(readReleaseAnswer(answered(403, "", { "x-ratelimit-remaining": "59" }), NOW)).toEqual({
			outcome: "unreadable",
		})
	})

	it("reads GitHub failing as unreachable", () => {
		expect(readReleaseAnswer(answered(502, "Bad Gateway"), NOW)).toEqual({
			outcome: "unreachable",
		})
	})

	it("reads a request the egress policy refused as unreachable", () => {
		expect(
			readReleaseAnswer({ sent: false, reason: "it points at a private network" }, NOW),
		).toEqual({ outcome: "unreachable" })
	})
})

describe("a request that fails outright", () => {
	it("reads an answer past the size limit as unreadable", () => {
		expect(checkFailureOf(new errors.ResponseExceededMaxSizeError())).toEqual({
			outcome: "unreadable",
		})
	})

	it("reads any other failure as unreachable", () => {
		expect(checkFailureOf(new Error("connect ECONNREFUSED"))).toEqual({ outcome: "unreachable" })
		expect(checkFailureOf(undefined)).toEqual({ outcome: "unreachable" })
	})

	it("records a failed request instead of failing the job", async () => {
		const { check, recorded } = harness({
			answer: async () => {
				throw new Error("socket hang up")
			},
		})

		expect(await check()).toEqual({ checked: true, outcome: "unreachable" })
		expect(recorded.map((entry) => entry.result)).toEqual([{ outcome: "unreachable" }])
	})

	it("never fails the job on a rate limit, so nothing retries into it", async () => {
		const { check, recorded } = harness({ answer: async () => answered(429, "") })

		await expect(check()).resolves.toEqual({ checked: true, outcome: "rate-limited" })
		expect(recorded.map((entry) => entry.result.outcome)).toEqual(["rate-limited"])
	})

	it("records the source it asked and when it asked", async () => {
		const { check, recorded } = harness()
		await check()

		expect(recorded.map((entry) => [entry.source, entry.checkedAt])).toEqual([
			[PROJECT_SOURCE, NOW],
		])
	})
})

describe("whether a worker that has just started should check", () => {
	it("checks when nothing has ever been checked", () => {
		expect(shouldCheckAtBoot(RELEASE_BUILD, undefined, NOW)).toBe(true)
	})

	it("checks when the last check is older than the poll", () => {
		const stale = new Date(NOW.getTime() - UPDATE_CHECK_INTERVAL_MS - 1)
		expect(shouldCheckAtBoot(RELEASE_BUILD, stale, NOW)).toBe(true)
	})

	it("does not check when the last check is within the poll, so a restart loop sends nothing", () => {
		const fresh = new Date(NOW.getTime() - UPDATE_CHECK_INTERVAL_MS + 60_000)
		expect(shouldCheckAtBoot(RELEASE_BUILD, fresh, NOW)).toBe(false)
	})

	it("never checks from a development build", () => {
		expect(shouldCheckAtBoot({ version: "0.0.0-dev", commit: "unknown" }, undefined, NOW)).toBe(
			false,
		)
	})

	it("polls every six hours", () => {
		expect(UPDATE_CHECK_INTERVAL_MS).toBe(6 * 60 * 60 * 1000)
	})
})

describe("reporting a check", () => {
	const capture = () => {
		const lines: { level: string; message: string }[] = []
		const logger = createLogger({
			level: "debug",
			write: (line) => {
				const parsed = JSON.parse(line)
				lines.push({ level: String(parsed.level), message: String(parsed.message) })
			},
		})
		return { lines, report: updateCheckReporter(logger) }
	}

	it("warns with the outcome when a check did not get an answer", () => {
		const { lines, report } = capture()
		report({ checked: true, outcome: "rate-limited" })

		expect(lines).toEqual([{ level: "warn", message: "The release check failed: rate-limited" }])
	})

	it("warns when the recorded source is not one it will ask", () => {
		const { lines, report } = capture()
		report({ checked: false, reason: "unusable-source" })

		expect(lines.map((line) => line.level)).toEqual(["warn"])
	})

	it("says at info, not as a warning, that no release has been published", () => {
		const { lines, report } = capture()
		report({ checked: true, outcome: "not-found" })

		const info = { level: "info", message: "The release check found no published release" }
		expect(lines).toEqual([info])
	})

	it("says nothing for a development build, a recent check, or a check that got its answer", () => {
		const { lines, report } = capture()
		report({ checked: false, reason: "recent" })
		report({ checked: false, reason: "development" })
		report({ checked: true, outcome: "ok" })

		expect(lines).toEqual([])
	})
})
