import { describe, expect, it } from "vitest"
import { byteLength } from "./bounds"
import type { PinnedRequest, PinnedResult } from "./pinned"
import {
	DISCORD_CONTENT_CHARS,
	deliverDiscord,
	deliverGotify,
	deliverNtfy,
	deliverResend,
	deliverSlack,
	deliverTeams,
	discordContent,
	fitsTeamsMessage,
	gotifyUrl,
	type NotificationEnvelope,
	NTFY_MESSAGE_BYTES,
	ntfyMessage,
	RESEND_URL,
	SLACK_TEXT_CHARS,
	slackText,
	teamsBody,
} from "./sender"

const envelope: NotificationEnvelope = {
	id: "ntf_abc123",
	deliveryId: "dlv_xyz789",
	kind: "instance.disconnected",
	title: "steve-bot left the server",
	body: "It has not come back on its own.",
	subjectType: "instance",
	subjectId: "ins_1",
	occurredAt: new Date("2026-09-07T12:00:00Z"),
}

const resolved: NotificationEnvelope = { ...envelope, kind: "instance.reconnected" }

const huge: NotificationEnvelope = {
	...envelope,
	title: "t".repeat(5_000),
	body: "€".repeat(50_000),
}

const transportReturning = (result: PinnedResult) => {
	const seen: PinnedRequest[] = []
	const transport = async (request: PinnedRequest): Promise<PinnedResult> => {
		seen.push(request)
		return result
	}
	return { transport, seen }
}

const answered = (
	status: number,
	body = "",
	headers: Readonly<Record<string, string>> = {},
): PinnedResult => ({ sent: true, status, headers, body })

const exactly = (value: Record<string, string | number | readonly string[]>): string =>
	JSON.stringify(value)

describe("what Discord actually receives", () => {
	it("sends the message as content and reads 204 as delivered", async () => {
		const { transport, seen } = transportReturning(answered(204))

		const outcome = await deliverDiscord(
			{ url: "https://discord.com/api/webhooks/1/tok" },
			envelope,
			{ transport },
		)

		expect(outcome.kind).toBe("delivered")
		expect(seen[0]?.method).toBe("POST")
		expect(seen[0]?.body).toBe(
			exactly({ content: "steve-bot left the server\nIt has not come back on its own." }),
		)
	})

	it("waits as long as the body asked, rounded up", async () => {
		const { transport } = transportReturning(answered(429, '{"retry_after":1.2}'))

		const outcome = await deliverDiscord(
			{ url: "https://discord.com/api/webhooks/1/tok" },
			envelope,
			{ transport },
		)

		expect(outcome.kind === "retryable" && outcome.retryAfterSeconds).toBe(2)
	})

	it("keeps content inside what Discord will take", () => {
		expect(Array.from(discordContent(huge))).toHaveLength(DISCORD_CONTENT_CHARS)
	})
})

describe("what Slack actually receives", () => {
	it("sends text and never reads the body it sends back", async () => {
		const { transport, seen } = transportReturning(answered(200, "ok"))

		const outcome = await deliverSlack(
			{ url: "https://hooks.slack.com/services/T/B/x" },
			envelope,
			{
				transport,
			},
		)

		expect(outcome.kind).toBe("delivered")
		expect(seen[0]?.body).toBe(
			exactly({ text: "steve-bot left the server\nIt has not come back on its own." }),
		)
	})

	it("retries its 500 and gives up on its 404, without quoting either", async () => {
		const rollup = transportReturning(answered(500, "rollup_error"))
		const gone = transportReturning(answered(404, "channel_not_found"))

		const retryable = await deliverSlack(
			{ url: "https://hooks.slack.com/services/T/B/x" },
			envelope,
			{ transport: rollup.transport },
		)
		const terminal = await deliverSlack(
			{ url: "https://hooks.slack.com/services/T/B/x" },
			envelope,
			{ transport: gone.transport },
		)

		expect(retryable.kind).toBe("retryable")
		expect(terminal.kind).toBe("terminal")
		expect(retryable.kind === "retryable" && retryable.reason).not.toContain("rollup_error")
		expect(terminal.kind === "terminal" && terminal.reason).not.toContain("channel_not_found")
	})

	it("honours the delay Slack asks for", async () => {
		const { transport } = transportReturning(answered(429, "", { "retry-after": "30" }))

		const outcome = await deliverSlack(
			{ url: "https://hooks.slack.com/services/T/B/x" },
			envelope,
			{
				transport,
			},
		)

		expect(outcome.kind === "retryable" && outcome.retryAfterSeconds).toBe(30)
	})

	it("keeps text inside what Slack will take", () => {
		expect(Array.from(slackText(huge))).toHaveLength(SLACK_TEXT_CHARS)
	})
})

describe("what Teams actually receives", () => {
	it("sends a card with no buttons, because a workflow cannot run them", async () => {
		const { transport, seen } = transportReturning(answered(202))

		const outcome = await deliverTeams(
			{
				url: "https://abc.05.environment.api.powerplatform.com/powerautomate/automations/direct/workflows/9f/triggers/manual/paths/invoke?sig=zz",
			},
			envelope,
			{ transport },
		)

		expect(outcome.kind).toBe("delivered")
		expect(seen[0]?.body).toBe(
			exactly({
				"@type": "MessageCard",
				"@context": "https://schema.org/extensions",
				summary: "steve-bot left the server",
				themeColor: "D1242F",
				title: "steve-bot left the server",
				text: "It has not come back on its own.",
			}),
		)
		expect(seen[0]?.body).not.toContain("potentialAction")
	})

	it("colours a recovery differently from a problem", () => {
		expect(teamsBody(envelope)).toContain('"themeColor":"D1242F"')
		expect(teamsBody(resolved)).toContain('"themeColor":"2EA043"')
	})

	it("stays inside the message limit even for an absurd alert", () => {
		expect(fitsTeamsMessage(teamsBody(huge))).toBe(true)
	})
})

describe("what Gotify actually receives", () => {
	it("puts its token in a header and its priority as a number", async () => {
		const { transport, seen } = transportReturning(answered(200))

		const outcome = await deliverGotify(
			{ serverUrl: "https://push.example.com", appToken: "AbCd", priority: 7 },
			envelope,
			{ transport },
		)

		expect(outcome.kind).toBe("delivered")
		expect(seen[0]?.url).toBe("https://push.example.com/message")
		expect(seen[0]?.headers["x-gotify-key"]).toBe("AbCd")
		expect(seen[0]?.body).toBe(
			exactly({
				title: "steve-bot left the server",
				message: "It has not come back on its own.",
				priority: 7,
			}),
		)
	})

	it("appends its path to a server behind a subpath without doubling the slash", () => {
		expect(gotifyUrl("https://push.example.com/")).toBe("https://push.example.com/message")
		expect(gotifyUrl("https://example.com/gotify")).toBe("https://example.com/gotify/message")
	})
})

describe("what ntfy actually receives", () => {
	it("names the topic in the body and the token in a header", async () => {
		const { transport, seen } = transportReturning(answered(200))

		const outcome = await deliverNtfy(
			{ serverUrl: "https://ntfy.example.com", topic: "open-mcc", priority: 4, accessToken: "tk" },
			envelope,
			{ transport },
		)

		expect(outcome.kind).toBe("delivered")
		expect(seen[0]?.url).toBe("https://ntfy.example.com")
		expect(seen[0]?.headers.authorization).toBe("Bearer tk")
		expect(seen[0]?.body).toBe(
			exactly({
				topic: "open-mcc",
				title: "steve-bot left the server",
				message: "It has not come back on its own.",
				priority: 4,
			}),
		)
	})

	it("sends no authorization header when no token is configured", async () => {
		const { transport, seen } = transportReturning(answered(200))

		await deliverNtfy(
			{ serverUrl: "https://ntfy.example.com", topic: "open-mcc", priority: 3 },
			envelope,
			{ transport },
		)

		expect(seen[0]?.headers.authorization).toBeUndefined()
	})

	it("stays under the size past which ntfy turns a message into a file", () => {
		expect(byteLength(ntfyMessage(huge))).toBeLessThanOrEqual(NTFY_MESSAGE_BYTES)
	})
})

describe("what Resend actually receives", () => {
	it("keys the send to the delivery so a retry cannot send a second email", async () => {
		const { transport, seen } = transportReturning(answered(200, '{"id":"em_1"}'))

		const outcome = await deliverResend(
			{
				apiKey: "re_live_key",
				fromAddress: "alerts@example.com",
				toAddresses: ["on-call@example.com"],
			},
			envelope,
			{ transport },
		)

		expect(outcome.kind).toBe("delivered")
		expect(seen[0]?.url).toBe(RESEND_URL)
		expect(seen[0]?.headers["idempotency-key"]).toBe("dlv_xyz789")
		expect(seen[0]?.headers.authorization).toBe("Bearer re_live_key")
		expect(seen[0]?.body).toBe(
			exactly({
				from: "alerts@example.com",
				to: ["on-call@example.com"],
				subject: "steve-bot left the server",
				text: "It has not come back on its own.",
			}),
		)
	})

	it("sends the same key on every attempt of the same delivery", async () => {
		const first = transportReturning(answered(503))
		const second = transportReturning(answered(200))
		const settings = {
			apiKey: "re_live_key",
			fromAddress: "alerts@example.com",
			toAddresses: ["on-call@example.com"],
		}

		await deliverResend(settings, envelope, { transport: first.transport })
		await deliverResend(settings, envelope, { transport: second.transport })

		expect(first.seen[0]?.headers["idempotency-key"]).toBe(
			second.seen[0]?.headers["idempotency-key"],
		)
	})

	it("retries a rate limit and gives up on a spent quota", async () => {
		const limited = transportReturning(answered(429, '{"name":"rate_limit_exceeded"}'))
		const spent = transportReturning(answered(429, '{"name":"daily_quota_exceeded"}'))
		const settings = {
			apiKey: "re_live_key",
			fromAddress: "alerts@example.com",
			toAddresses: ["on-call@example.com"],
		}

		expect((await deliverResend(settings, envelope, { transport: limited.transport })).kind).toBe(
			"retryable",
		)
		expect((await deliverResend(settings, envelope, { transport: spent.transport })).kind).toBe(
			"terminal",
		)
	})
})

describe("no sender puts a credential where it would be logged", () => {
	it("keeps every configured token out of the request URL", async () => {
		const accepted = answered(200)
		const calls: PinnedRequest[] = []
		const record = async (request: PinnedRequest): Promise<PinnedResult> => {
			calls.push(request)
			return accepted
		}

		await deliverGotify(
			{ serverUrl: "https://push.example.com", appToken: "gotify-secret", priority: 5 },
			envelope,
			{ transport: record },
		)
		await deliverNtfy(
			{
				serverUrl: "https://ntfy.example.com",
				topic: "open-mcc",
				priority: 3,
				accessToken: "ntfy-secret",
			},
			envelope,
			{ transport: record },
		)
		await deliverResend(
			{
				apiKey: "resend-secret",
				fromAddress: "alerts@example.com",
				toAddresses: ["on-call@example.com"],
			},
			envelope,
			{ transport: record },
		)

		for (const secret of ["gotify-secret", "ntfy-secret", "resend-secret"]) {
			for (const call of calls) expect(call.url).not.toContain(secret)
		}
		expect(calls).toHaveLength(3)
	})
})
