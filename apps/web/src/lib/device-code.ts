import type { DeviceCodeChallenge } from "@open-mcc/contracts"

const MINUTE_MS = 60_000

type ExpiresAt = DeviceCodeChallenge["expiresAt"]

export const hasCodeExpired = (expiresAt: ExpiresAt, now: number): boolean =>
	new Date(expiresAt).getTime() <= now

export const describeCodeValidity = (expiresAt: ExpiresAt, now: number): string => {
	if (hasCodeExpired(expiresAt, now)) return "This code has expired. Get a new one."
	const minutes = Math.ceil((new Date(expiresAt).getTime() - now) / MINUTE_MS)
	return `Valid for ${minutes} more minute${minutes === 1 ? "" : "s"}.`
}
