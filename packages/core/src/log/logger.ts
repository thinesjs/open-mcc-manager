import { redact } from "../security/redact"

export const LEVELS = ["debug", "info", "warn", "error"] as const

export type Level = (typeof LEVELS)[number]

export type Field = string | number | boolean | null

export type Fields = Readonly<Record<string, Field>>

export type TraceIds = { readonly trace_id: string; readonly span_id: string }

export type Logger = {
	readonly debug: (message: string, fields?: Fields) => void
	readonly info: (message: string, fields?: Fields) => void
	readonly warn: (message: string, fields?: Fields) => void
	readonly error: (message: string, fields?: Fields) => void
	readonly child: (fields: Fields) => Logger
}

export type LoggerDeps = {
	readonly level?: Level
	readonly service?: string
	readonly now?: () => Date
	readonly write?: (line: string) => void
	readonly activeTrace?: () => TraceIds | undefined
	readonly base?: Fields
}

const RANK: Readonly<Record<Level, number>> = { debug: 10, info: 20, warn: 30, error: 40 }

export const readLevel = (raw: string | undefined): Level => {
	const found = LEVELS.find((level) => level === raw?.trim().toLowerCase())
	return found ?? "info"
}

const clean = (value: Field): Field => (typeof value === "string" ? redact(value) : value)

const ordered = (entry: Readonly<Record<string, Field>>): string => JSON.stringify(entry)

export const createLogger = (deps: LoggerDeps = {}): Logger => {
	const threshold = RANK[deps.level ?? "info"]
	const now = deps.now ?? (() => new Date())
	const write = deps.write ?? ((line: string) => void process.stdout.write(line))
	const base = deps.base ?? {}

	const emit = (level: Level, message: string, fields: Fields) => {
		if (RANK[level] < threshold) return

		const trace = deps.activeTrace?.()
		const merged: Record<string, Field> = {
			time: now().toISOString(),
			level,
			message: redact(message),
		}
		if (deps.service !== undefined) merged.service = deps.service
		if (trace !== undefined) {
			merged.trace_id = trace.trace_id
			merged.span_id = trace.span_id
		}
		for (const [key, value] of Object.entries(base)) merged[key] = clean(value)
		for (const [key, value] of Object.entries(fields)) merged[key] = clean(value)

		write(`${ordered(merged)}\n`)
	}

	const logger: Logger = {
		debug: (message, fields = {}) => emit("debug", message, fields),
		info: (message, fields = {}) => emit("info", message, fields),
		warn: (message, fields = {}) => emit("warn", message, fields),
		error: (message, fields = {}) => emit("error", message, fields),
		child: (fields) =>
			createLogger({
				...deps,
				base: { ...base, ...fields },
			}),
	}
	return logger
}
