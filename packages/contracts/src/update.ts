import { z } from "zod"

const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/

const REPO_PATTERN = /^[A-Za-z0-9._-]{1,100}$/

const RELEASE_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/

export const sourceOwnerSchema = z.string().regex(OWNER_PATTERN)

export const sourceRepoSchema = z
	.string()
	.regex(REPO_PATTERN)
	.refine((repo) => repo !== "." && repo !== "..")

export const updateSourceSchema = z.object({
	owner: sourceOwnerSchema,
	repo: sourceRepoSchema,
})

export type UpdateSource = z.infer<typeof updateSourceSchema>

export const PROJECT_SOURCE: UpdateSource = { owner: "thinesjs", repo: "open-mcc-manager" }

export const UPDATE_CHECK_OUTCOMES = [
	"ok",
	"unreachable",
	"rate-limited",
	"not-found",
	"unreadable",
] as const

export const updateCheckOutcomeSchema = z.enum(UPDATE_CHECK_OUTCOMES)

export type UpdateCheckOutcome = z.infer<typeof updateCheckOutcomeSchema>

export const releaseVersionSchema = z.string().regex(RELEASE_VERSION_PATTERN)

const offsetSchema = z.number().int().nonnegative()

export const releaseNoteSpanSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("text"), start: offsetSchema, text: z.string() }),
	z.object({ kind: z.literal("bold"), start: offsetSchema, text: z.string() }),
	z.object({ kind: z.literal("italic"), start: offsetSchema, text: z.string() }),
	z.object({ kind: z.literal("code"), start: offsetSchema, text: z.string() }),
	z.object({ kind: z.literal("link"), start: offsetSchema, label: z.string(), url: z.string() }),
])

export type ReleaseNoteSpan = z.infer<typeof releaseNoteSpanSchema>

export const releaseNoteBlockSchema = z.discriminatedUnion("kind", [
	z.object({
		kind: z.literal("heading"),
		start: offsetSchema,
		spans: z.array(releaseNoteSpanSchema),
	}),
	z.object({
		kind: z.literal("paragraph"),
		start: offsetSchema,
		spans: z.array(releaseNoteSpanSchema),
	}),
	z.object({
		kind: z.literal("bullet"),
		start: offsetSchema,
		spans: z.array(releaseNoteSpanSchema),
	}),
	z.object({
		kind: z.literal("numbered"),
		start: offsetSchema,
		number: z.string(),
		spans: z.array(releaseNoteSpanSchema),
	}),
	z.object({ kind: z.literal("code"), start: offsetSchema, text: z.string() }),
])

export type ReleaseNoteBlock = z.infer<typeof releaseNoteBlockSchema>

export const updateStatusSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("development") }),
	z.object({ kind: z.literal("unchecked"), running: z.string() }),
	z.object({
		kind: z.literal("checked"),
		running: z.string(),
		latest: releaseVersionSchema.nullable(),
		available: z.boolean(),
		checkedAt: z.string(),
		outcome: updateCheckOutcomeSchema,
		rateLimitedUntil: z.string().nullable(),
		source: updateSourceSchema.nullable(),
	}),
])

export type UpdateStatus = z.infer<typeof updateStatusSchema>

export const releaseNotesViewSchema = z.object({
	version: releaseVersionSchema,
	source: updateSourceSchema,
	blocks: z.array(releaseNoteBlockSchema),
	truncated: z.boolean(),
})

export type ReleaseNotesView = z.infer<typeof releaseNotesViewSchema>

export const releasePageUrl = (source: UpdateSource, version: string): string =>
	`https://github.com/${source.owner}/${source.repo}/releases/tag/v${version}`

type VersionParts = readonly [bigint, bigint, bigint]

const partsOf = (version: string): VersionParts | undefined => {
	const match = RELEASE_VERSION_PATTERN.exec(version)
	const major = match?.[1]
	const minor = match?.[2]
	const patch = match?.[3]
	if (major === undefined || minor === undefined || patch === undefined) return undefined
	return [BigInt(major), BigInt(minor), BigInt(patch)]
}

export const compareVersions = (left: string, right: string): -1 | 0 | 1 | undefined => {
	const a = partsOf(left)
	const b = partsOf(right)
	if (a === undefined || b === undefined) return undefined
	for (const index of [0, 1, 2] as const) {
		if (a[index] > b[index]) return 1
		if (a[index] < b[index]) return -1
	}
	return 0
}

export const isNewerThan = (candidate: string, running: string): boolean =>
	compareVersions(candidate, running) === 1
