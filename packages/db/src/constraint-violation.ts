import { DatabaseError } from "pg"

export const CONSTRAINT_VIOLATION_KINDS = ["unique", "foreignKey", "check", "exclusion"] as const

export type ConstraintViolationKind = (typeof CONSTRAINT_VIOLATION_KINDS)[number]

export type ConstraintViolation = {
	kind: ConstraintViolationKind
	constraint: string
}

const KIND_BY_SQLSTATE: Record<string, ConstraintViolationKind> = {
	"23001": "foreignKey",
	"23503": "foreignKey",
	"23505": "unique",
	"23514": "check",
	"23P01": "exclusion",
}

export const constraintViolationOf = (error: Error): ConstraintViolation | null => {
	if (!(error instanceof DatabaseError)) return null
	const code = error.code
	if (code === undefined) return null
	const kind = KIND_BY_SQLSTATE[code]
	if (kind === undefined) return null
	return { kind, constraint: error.constraint ?? "" }
}
