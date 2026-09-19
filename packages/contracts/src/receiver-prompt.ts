import { SIGNATURE_VERSION, SIGNING_SECRET_PREFIX } from "./notification"

export const RECEIVER_SECRET_ENV = "OPENMCC_WEBHOOK_SECRET"

export const CURSOR_DEEPLINK_LIMIT = 8000

export const receiverPrompt = (): string =>
	[
		"Write a small HTTP server that receives signed webhooks and verifies them.",
		"",
		"Requirements:",
		`- Read the signing key from the ${RECEIVER_SECRET_ENV} environment variable. Never hard-code it.`,
		"- Accept POST requests with a JSON body on a single configurable path.",
		"- Three request headers arrive: webhook-id, webhook-timestamp, webhook-signature.",
		`- webhook-signature is "${SIGNATURE_VERSION},<base64>", and may contain several space-separated values during a key rotation. Accept the request if ANY of them matches.`,
		'- The signature is HMAC-SHA256, base64 encoded, over the exact string formed by joining the webhook-id, the webhook-timestamp and the body with a single "." between each, in that order. Use the RAW REQUEST BODY BYTES, not a re-serialised copy of the parsed JSON.',
		`- The HMAC key is the signing key with its "${SIGNING_SECRET_PREFIX}" prefix removed and the remainder base64-DECODED. Sign with those raw bytes, not with the prefixed string. This is the most common mistake.`,
		"- Compare signatures in constant time.",
		"- Reject the request if webhook-timestamp is more than five minutes from the server's own clock, to stop a captured request being replayed.",
		"- Treat webhook-id as an idempotency key: remember the ids you have handled and ignore a repeat.",
		"- Respond 2xx when accepted. Respond 400 when the signature does not verify. Respond 5xx only for a genuine internal failure, because the sender will retry those.",
		"- Log whether each request verified, and never log the signing key.",
		"",
		"Include a test that builds a correctly signed request and asserts it is accepted, and one that tampers with the body and asserts it is rejected.",
	].join("\n")

export const cursorDeeplink = (prompt: string): string =>
	`https://cursor.com/link/prompt?text=${encodeURIComponent(prompt)}`

export const claudeDesktopDeeplink = (prompt: string): string =>
	`claude://claude.ai/new?q=${encodeURIComponent(prompt)}`

export const withinDeeplinkLimit = (url: string): boolean => url.length <= CURSOR_DEEPLINK_LIMIT
