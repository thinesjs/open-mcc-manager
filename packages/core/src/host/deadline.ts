export const withDeadline = (killAfterSeconds: number, seconds: number, command: string): string =>
	`timeout -k ${killAfterSeconds} ${seconds} ${command}; s=$?; exit $s`

const DEADLINE_EXIT_CODES = [124, 137] as const

export const endedByDeadline = (exitCode: number): boolean =>
	DEADLINE_EXIT_CODES.some((code) => code === exitCode)
