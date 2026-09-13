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

export const releaseVersionSchema = z.string().regex(RELEASE_VERSION_PATTERN)

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
