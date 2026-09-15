export const withDeadline = (killAfterSeconds: number, seconds: number, command: string): string =>
	`timeout -k ${killAfterSeconds} ${seconds} ${command}; s=$?; exit $s`
