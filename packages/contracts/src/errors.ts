import { z } from "zod"

export const ERROR_CODES = [
	"UNAUTHORIZED",
	"FORBIDDEN",
	"HOST_NOT_FOUND",
	"SSH_KEY_NOT_FOUND",
	"FINGERPRINT_MISMATCH",
	"HOST_MISCONFIGURED",
	"HOST_CONCURRENTLY_MODIFIED",
	"HOST_PROVISIONING_IN_PROGRESS",
	"INVITATION_NOT_FOUND",
	"SSH_KEY_IN_USE",
	"HOST_NAME_TAKEN",
	"SSH_KEY_NAME_TAKEN",
	"CONSTRAINT_VIOLATION",
] as const

export const errorCodeSchema = z.enum(ERROR_CODES)

export type ErrorCode = z.infer<typeof errorCodeSchema>

const ERROR_CODE_SET: ReadonlySet<string> = new Set(ERROR_CODES)

export const isErrorCode = (value: string | undefined): value is ErrorCode =>
	value !== undefined && ERROR_CODE_SET.has(value)
