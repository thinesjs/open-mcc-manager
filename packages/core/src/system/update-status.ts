import {
	isNewerThan,
	type ReleaseNotesView,
	releaseVersionSchema,
	type UpdateStatus,
	updateSourceSchema,
} from "@open-mcc/contracts"
import type { UpdateStateRow } from "@open-mcc/db"
import { type BuildInfo, isDevelopmentBuild } from "./build-info"
import { parseReleaseNotes } from "./release-notes"

const releaseVersionOf = (value: string | null): string | null =>
	value !== null && releaseVersionSchema.safeParse(value).success ? value : null

export const updateStatusFor = (
	build: BuildInfo,
	row: UpdateStateRow | undefined,
): UpdateStatus => {
	if (isDevelopmentBuild(build)) return { kind: "development" }
	if (row === undefined) return { kind: "unchecked", running: build.version }
	const source = updateSourceSchema.safeParse({ owner: row.sourceOwner, repo: row.sourceRepo })
	const latest = releaseVersionOf(row.latestVersion)
	return {
		kind: "checked",
		running: build.version,
		latest,
		available: latest !== null && isNewerThan(latest, build.version),
		checkedAt: row.checkedAt.toISOString(),
		outcome: row.checkOutcome,
		rateLimitedUntil: row.rateLimitedUntil === null ? null : row.rateLimitedUntil.toISOString(),
		source: source.success ? source.data : null,
	}
}

export const releaseNotesFor = (
	build: BuildInfo,
	row: UpdateStateRow | undefined,
): ReleaseNotesView | null => {
	if (row === undefined) return null
	const status = updateStatusFor(build, row)
	if (status.kind !== "checked" || !status.available) return null
	if (status.latest === null || status.source === null) return null
	const parsed = parseReleaseNotes(row.latestNotes ?? "")
	return {
		version: status.latest,
		source: status.source,
		blocks: parsed.blocks,
		truncated: row.notesTruncated || parsed.capped,
	}
}
