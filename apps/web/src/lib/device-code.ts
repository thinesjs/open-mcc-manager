const MINUTE_MS = 60_000

export const hasCodeExpired = (expiresAt: Date | string, now: number): boolean =>
	new Date(expiresAt).getTime() <= now

export const describeCodeValidity = (expiresAt: Date | string, now: number): string => {
	if (hasCodeExpired(expiresAt, now)) return "This code has expired. Get a new one."
	const minutes = Math.ceil((new Date(expiresAt).getTime() - now) / MINUTE_MS)
	return `Valid for ${minutes} more minute${minutes === 1 ? "" : "s"}.`
}
