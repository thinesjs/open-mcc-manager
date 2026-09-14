import type { UpdateCheckOutcome } from "@open-mcc/contracts"

export const DEVELOPMENT_BUILD_TOOLTIP = "Development builds are not updated from here."

export const RELEASE_NOTES_SHOWN_FIRST = 12

const MINUTE_MS = 60_000

const HOUR_MS = 60 * MINUTE_MS

const DAY_MS = 24 * HOUR_MS

const counted = (count: number, unit: string): string =>
	`${count} ${unit}${count === 1 ? "" : "s"} ago`

export const checkedAgo = (checkedAt: Date, now: Date): string => {
	const elapsed = Math.max(0, now.getTime() - checkedAt.getTime())
	if (elapsed < MINUTE_MS) return "just now"
	if (elapsed < HOUR_MS) return counted(Math.floor(elapsed / MINUTE_MS), "minute")
	if (elapsed < DAY_MS) return counted(Math.floor(elapsed / HOUR_MS), "hour")
	return counted(Math.floor(elapsed / DAY_MS), "day")
}

export type CheckFailure = Exclude<UpdateCheckOutcome, "ok">

export const CHECK_FAILURE_COPY: Record<CheckFailure, string> = {
	unreachable: "GitHub could not be reached.",
	"rate-limited": "GitHub is limiting requests from this network.",
	"not-found": "No release was found. The repository may have moved or not published one.",
	unreadable: "GitHub's answer could not be read.",
}

export const checkFailureReason = (
	outcome: CheckFailure,
	rateLimitedUntil: Date | null,
	formatTime: (at: Date) => string,
): string =>
	outcome === "rate-limited" && rateLimitedUntil !== null
		? `GitHub is limiting requests from this network until ${formatTime(rateLimitedUntil)}.`
		: CHECK_FAILURE_COPY[outcome]
