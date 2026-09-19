import { timingSafeEqual } from "node:crypto"
import { fingerprintFromKey } from "@open-mcc/contracts/boundary/ssh"

export type VerificationResult =
	| { ok: true; fingerprint: string }
	| { ok: false; presented: string; expected: string }

export const verifyHostKey = (presented: Buffer, expected: string): VerificationResult => {
	const fingerprint = fingerprintFromKey(presented)
	if (expected.length === 0) return { ok: false, presented: fingerprint, expected }
	const a = Buffer.from(fingerprint)
	const b = Buffer.from(expected)
	const match = a.length === b.length && timingSafeEqual(a, b)
	return match ? { ok: true, fingerprint } : { ok: false, presented: fingerprint, expected }
}
