import { describe, expect, it, vi } from "vitest"
import type { PinnedRequest, PinnedResult } from "./pinned"
import {
	deliverTelegram,
	deliverWebhook,
	type NotificationEnvelope,
	telegramText,
	telegramUrl,
	webhookBody,
} from "./sender"
import { verifySignature } from "./signature"

const envelope: NotificationEnvelope = {
	id: "ntf_abc123",
	kind: "host.unreachable",
	title: "basement-box is not responding",
	body: "OpenMCC cannot reach this machine, so the bots on it are unmanaged.",
	subjectType: "host",
	subjectId: "host_1",
	occurredAt: new Date("2026-09-07T12:00:00Z"),
}

const now = () => new Date("2026-09-07T12:00:05Z")

const transportReturning = (result: PinnedResult) => {
	const seen: PinnedRequest[] = []
	const transport = async (request: PinnedRequest): Promise<PinnedResult> => {
		seen.push(request)
		return result
	}
	return { transport, seen }
}

const accepted: PinnedResult = { sent: true, status: 200, headers: {}, body: "" }

describe("the webhook a receiver actually gets", () => {
	it("signs it so the receiver can prove we sent it", async () => {
		const secret = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw"
		const { transport, seen } = transportReturning(accepted)

		await deliverWebhook(
			{ url: "https://hooks.example.com/x", signingSecrets: [secret] },
			envelope,
			{
				transport,
				now,
			},
		)

		const request = seen[0]
		expect(request?.headers["webhook-id"]).toBe("ntf_abc123")
		expect(request?.headers["webhook-timestamp"]).toBe("1788782405")
		expect(
			verifySignature(
				request?.headers["webhook-signature"] ?? "",
				secret,
				"ntf_abc123",
				"1788782405",
				request?.body ?? "",
			),
		).toBe(true)
	})

	it("signs with both secrets during a rotation, so neither receiver breaks", async () => {
		const current = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw"
		const previous = "whsec_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
		const { transport, seen } = transportReturning(accepted)

		await deliverWebhook(
			{ url: "https://hooks.example.com/x", signingSecrets: [current, previous] },
			envelope,
			{ transport, now },
		)

		const header = seen[0]?.headers["webhook-signature"] ?? ""
		expect(header.split(" ")).toHaveLength(2)
		expect(verifySignature(header, current, "ntf_abc123", "1788782405", seen[0]?.body ?? "")).toBe(
			true,
		)
		expect(verifySignature(header, previous, "ntf_abc123", "1788782405", seen[0]?.body ?? "")).toBe(
			true,
		)
	})

	it("carries the message, not our internals", () => {
		expect(webhookBody(envelope)).toBe(
			JSON.stringify({
				type: "host.unreachable",
				timestamp: "2026-09-07T12:00:00.000Z",
				data: {
					id: "ntf_abc123",
					title: "basement-box is not responding",
					body: "OpenMCC cannot reach this machine, so the bots on it are unmanaged.",
					subject: { type: "host", id: "host_1" },
				},
			}),
		)
	})

	it("signs exactly the bytes it sends, not a re-serialised copy", async () => {
		const secret = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw"
		const { transport, seen } = transportReturning(accepted)
		await deliverWebhook(
			{ url: "https://hooks.example.com/x", signingSecrets: [secret] },
			envelope,
			{
				transport,
				now,
			},
		)
		expect(seen[0]?.body).toBe(webhookBody(envelope))
	})
})

describe("what a webhook's answer means", () => {
	it("counts a 2xx as delivered", async () => {
		const { transport } = transportReturning(accepted)
		const outcome = await deliverWebhook(
			{ url: "https://hooks.example.com/x", signingSecrets: ["whsec_AAAA"] },
			envelope,
			{ transport, now },
		)
		expect(outcome.kind).toBe("delivered")
	})

	it("takes 410 as a request to stop", async () => {
		const { transport } = transportReturning({ sent: true, status: 410, headers: {}, body: "" })
		const outcome = await deliverWebhook(
			{ url: "https://hooks.example.com/x", signingSecrets: ["whsec_AAAA"] },
			envelope,
			{ transport, now },
		)
		expect(outcome.kind === "terminal" && outcome.stopSending).toBe(true)
	})

	it("picks Retry-After off a 429", async () => {
		const { transport } = transportReturning({
			sent: true,
			status: 429,
			headers: { "retry-after": "90" },
			body: "",
		})
		const outcome = await deliverWebhook(
			{ url: "https://hooks.example.com/x", signingSecrets: ["whsec_AAAA"] },
			envelope,
			{ transport, now },
		)
		expect(outcome.kind === "retryable" && outcome.retryAfterSeconds).toBe(90)
	})

	it("does not retry an address we refused to dial", async () => {
		const { transport } = transportReturning({
			sent: false,
			reason: "it points at a private network",
		})
		const outcome = await deliverWebhook(
			{ url: "https://hooks.example.com/x", signingSecrets: ["whsec_AAAA"] },
			envelope,
			{ transport, now },
		)
		expect(outcome.kind).toBe("terminal")
		expect(outcome.kind === "terminal" && outcome.reason).toBe("it points at a private network")
	})

	it("retries a connection that fell over, and never leaks a secret in the reason", async () => {
		const transport = vi.fn(async () => {
			throw new Error("connect ECONNREFUSED using whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw")
		})
		const outcome = await deliverWebhook(
			{ url: "https://hooks.example.com/x", signingSecrets: ["whsec_AAAA"] },
			envelope,
			{ transport, now },
		)

		expect(outcome.kind).toBe("retryable")
		expect(outcome.kind === "retryable" && outcome.reason).not.toContain("whsec_MfKQ")
	})
})

describe("Telegram, which hides its failures inside a 200", () => {
	it("sends the message to the chat", async () => {
		const { transport, seen } = transportReturning({
			sent: true,
			status: 200,
			headers: {},
			body: '{"ok":true}',
		})

		const outcome = await deliverTelegram({ botToken: "123:AAA", chatId: "-1001" }, envelope, {
			transport,
			now,
		})

		expect(outcome.kind).toBe("delivered")
		expect(seen[0]?.url).toBe(telegramUrl("123:AAA"))
		expect(seen[0]?.body).toBe(
			JSON.stringify({
				chat_id: "-1001",
				text: telegramText(envelope),
				disable_notification: false,
			}),
		)
	})

	it("includes a topic only when there is one", async () => {
		const { transport, seen } = transportReturning({
			sent: true,
			status: 200,
			headers: {},
			body: '{"ok":true}',
		})

		await deliverTelegram({ botToken: "123:AAA", chatId: "-1001", messageThreadId: 9 }, envelope, {
			transport,
			now,
		})

		expect(seen[0]?.body).toContain('"message_thread_id":9')
	})

	it("believes the body over the status line", async () => {
		const { transport } = transportReturning({
			sent: true,
			status: 200,
			headers: {},
			body: '{"ok":false,"error_code":400,"description":"chat not found"}',
		})

		const outcome = await deliverTelegram({ botToken: "123:AAA", chatId: "-1001" }, envelope, {
			transport,
			now,
		})

		expect(outcome.kind).toBe("terminal")
		expect(outcome.kind === "terminal" && outcome.reason).toBe("chat not found")
	})

	it("waits as long as Telegram asks when it is rate limited", async () => {
		const { transport } = transportReturning({
			sent: true,
			status: 200,
			headers: {},
			body: '{"ok":false,"error_code":429,"description":"Too Many Requests","parameters":{"retry_after":31}}',
		})

		const outcome = await deliverTelegram({ botToken: "123:AAA", chatId: "-1001" }, envelope, {
			transport,
			now,
		})

		expect(outcome.kind === "retryable" && outcome.retryAfterSeconds).toBe(31)
	})
})
