import {
	PROJECT_SOURCE,
	releaseVersionSchema,
	type UpdateCheckOutcome,
	type UpdateSource,
	updateSourceSchema,
} from "@open-mcc/contracts"
import { parseLatestRelease } from "@open-mcc/contracts/boundary/github-release"
import type { UpdateStateRow } from "@open-mcc/db"
import { errors } from "undici"
import type { Logger } from "../log/logger"
import { byteLength, truncateBytes } from "../notification/bounds"
import { type PinnedRequest, type PinnedResult, sendPinned } from "../notification/pinned"
import { type BuildInfo, isDevelopmentBuild } from "./build-info"
import type { UpdateCheckResult } from "./update-state.repository"

export const UPDATE_CHECK_CRON = "41 */6 * * *"

export const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000

export const RELEASE_RESPONSE_MAX_BYTES = 1024 * 1024

export const RELEASE_NOTES_MAX_BYTES = 64 * 1024

const RELEASE_REQUEST_HEADERS = {
	accept: "application/vnd.github+json",
	"user-agent": "open-mcc-manager",
	"x-github-api-version": "2022-11-28",
}

const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308])

const WHOLE_SECONDS = /^\d{1,10}$/

export const latestReleaseUrl = (source: UpdateSource): string =>
	`https://api.github.com/repos/${source.owner}/${source.repo}/releases/latest`

export const requestRelease = async (
	url: string,
	via: Pick<PinnedRequest, "policy" | "lookupAddresses"> = {},
): Promise<PinnedResult> =>
	await sendPinned({
		url,
		method: "GET",
		headers: RELEASE_REQUEST_HEADERS,
		maxResponseBytes: RELEASE_RESPONSE_MAX_BYTES,
		...via,
	})

const releaseFrom = (raw: string): UpdateCheckResult => {
	const parsed = parseLatestRelease(raw)
	if (parsed === undefined || !parsed.tagName.startsWith("v")) return { outcome: "unreadable" }
	const version = parsed.tagName.slice(1)
	if (!releaseVersionSchema.safeParse(version).success) return { outcome: "unreadable" }
	const body = parsed.body ?? ""
	if (body.trim().length === 0) {
		return { outcome: "ok", release: { version, notes: null, notesTruncated: false } }
	}
	return {
		outcome: "ok",
		release: {
			version,
			notes: truncateBytes(body, RELEASE_NOTES_MAX_BYTES),
			notesTruncated: byteLength(body) > RELEASE_NOTES_MAX_BYTES,
		},
	}
}

const secondsIn = (value: string | undefined): number | undefined =>
	value !== undefined && WHOLE_SECONDS.test(value) ? Number(value) : undefined

const rateLimitIn = (
	status: number,
	headers: Readonly<Record<string, string>>,
	now: Date,
): UpdateCheckResult | undefined => {
	const exhausted = headers["x-ratelimit-remaining"] === "0"
	const retryAfter = headers["retry-after"]
	if (status !== 429 && !(status === 403 && (exhausted || retryAfter !== undefined))) {
		return undefined
	}
	const wait = secondsIn(retryAfter)
	if (wait !== undefined) {
		return { outcome: "rate-limited", until: new Date(now.getTime() + wait * 1000) }
	}
	const reset = exhausted ? secondsIn(headers["x-ratelimit-reset"]) : undefined
	return { outcome: "rate-limited", until: reset === undefined ? null : new Date(reset * 1000) }
}

export const readReleaseAnswer = (answer: PinnedResult, now: Date): UpdateCheckResult => {
	if (!answer.sent) return { outcome: "unreachable" }
	if (answer.status === 200) return releaseFrom(answer.body)
	if (answer.status === 404 || REDIRECT_STATUSES.has(answer.status)) {
		return { outcome: "not-found" }
	}
	const limited = rateLimitIn(answer.status, answer.headers, now)
	if (limited !== undefined) return limited
	if (answer.status >= 500) return { outcome: "unreachable" }
	return { outcome: "unreadable" }
}

export const checkFailureOf = (error: Error | undefined): UpdateCheckResult =>
	error instanceof errors.ResponseExceededMaxSizeError
		? { outcome: "unreadable" }
		: { outcome: "unreachable" }

export const shouldCheckAtBoot = (
	build: BuildInfo,
	lastCheckedAt: Date | undefined,
	now: Date,
): boolean => {
	if (isDevelopmentBuild(build)) return false
	if (lastCheckedAt === undefined) return true
	return now.getTime() - lastCheckedAt.getTime() > UPDATE_CHECK_INTERVAL_MS
}

export type UpdateCheckRun =
	| { readonly checked: false; readonly reason: "development" | "recent" | "unusable-source" }
	| { readonly checked: true; readonly outcome: UpdateCheckOutcome }

export type UpdateCheckDeps = {
	readonly build: BuildInfo
	readonly readState: () => Promise<UpdateStateRow | undefined>
	readonly request: (url: string) => Promise<PinnedResult>
	readonly record: (
		source: UpdateSource,
		checkedAt: Date,
		result: UpdateCheckResult,
	) => Promise<void>
	readonly now: () => Date
}

const sourceOf = (row: UpdateStateRow | undefined): UpdateSource | undefined => {
	if (row === undefined) return PROJECT_SOURCE
	const parsed = updateSourceSchema.safeParse({ owner: row.sourceOwner, repo: row.sourceRepo })
	return parsed.success ? parsed.data : undefined
}

export const createUpdateCheck = (deps: UpdateCheckDeps) => async (): Promise<UpdateCheckRun> => {
	if (isDevelopmentBuild(deps.build)) return { checked: false, reason: "development" }
	const row = await deps.readState()
	const checkedAt = deps.now()
	const sinceLast = row === undefined ? undefined : checkedAt.getTime() - row.checkedAt.getTime()
	if (sinceLast !== undefined && sinceLast < UPDATE_CHECK_INTERVAL_MS / 2) {
		return { checked: false, reason: "recent" }
	}
	const source = sourceOf(row)
	if (source === undefined) return { checked: false, reason: "unusable-source" }

	let result: UpdateCheckResult
	try {
		result = readReleaseAnswer(await deps.request(latestReleaseUrl(source)), checkedAt)
	} catch (error) {
		result = checkFailureOf(error instanceof Error ? error : undefined)
	}
	await deps.record(source, checkedAt, result)
	return { checked: true, outcome: result.outcome }
}

export type UpdateCheckReporter = (run: UpdateCheckRun) => void

export const updateCheckReporter =
	(logger: Pick<Logger, "info" | "warn">): UpdateCheckReporter =>
	(run) => {
		if (!run.checked) {
			if (run.reason === "unusable-source") {
				logger.warn("The recorded release source is not a repository name this manager will ask")
			}
			return
		}
		if (run.outcome === "not-found") {
			logger.info("The release check found no published release")
			return
		}
		if (run.outcome !== "ok") logger.warn(`The release check failed: ${run.outcome}`)
	}

export type UpdateCheckJob = () => Promise<void>

export const updateCheckJob =
	(check: () => Promise<UpdateCheckRun>, report: UpdateCheckReporter): UpdateCheckJob =>
	async () =>
		report(await check())
