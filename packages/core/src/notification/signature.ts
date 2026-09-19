import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"
import { SIGNATURE_VERSION, SIGNING_SECRET_BYTES, SIGNING_SECRET_PREFIX } from "@open-mcc/contracts"

export const generateSigningSecret = (): string =>
	`${SIGNING_SECRET_PREFIX}${randomBytes(SIGNING_SECRET_BYTES).toString("base64")}`

export const signingKeyBytes = (secret: string): Buffer => {
	const encoded = secret.startsWith(SIGNING_SECRET_PREFIX)
		? secret.slice(SIGNING_SECRET_PREFIX.length)
		: secret
	return Buffer.from(encoded, "base64")
}

export const signedContent = (id: string, timestamp: string, body: string): string =>
	`${id}.${timestamp}.${body}`

export const signPayload = (secret: string, id: string, timestamp: string, body: string): string =>
	`${SIGNATURE_VERSION},${createHmac("sha256", signingKeyBytes(secret))
		.update(signedContent(id, timestamp, body), "utf8")
		.digest("base64")}`

export const signatureHeader = (
	secrets: readonly string[],
	id: string,
	timestamp: string,
	body: string,
): string => secrets.map((secret) => signPayload(secret, id, timestamp, body)).join(" ")

export const verifySignature = (
	header: string,
	secret: string,
	id: string,
	timestamp: string,
	body: string,
): boolean => {
	const expected = Buffer.from(signPayload(secret, id, timestamp, body), "utf8")
	return header
		.split(" ")
		.filter((candidate) => candidate.length > 0)
		.some((candidate) => {
			const offered = Buffer.from(candidate, "utf8")
			return offered.length === expected.length && timingSafeEqual(offered, expected)
		})
}
