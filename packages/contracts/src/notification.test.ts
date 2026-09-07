import { describe, expect, it } from "vitest"
import {
	createDestinationInput,
	DESTINATION_KINDS,
	DESTINATION_LABELS,
	NOTIFICATION_KINDS,
	ntfyConfigInput,
	SUBSCRIPTION_KINDS,
	TEST_NOTIFICATION_KIND,
	telegramConfigInput,
	usableSigningSecrets,
} from "./notification"
import {
	isNotifyingEvent,
	NOTIFYING_EVENT_KINDS,
	problemResolvedBy,
	RESOLVING_EVENT_KINDS,
	STATUS_EVENT_KINDS,
} from "./status"

describe("what an operator can subscribe to", () => {
	it("is exactly the set of events worth telling somebody about", () => {
		expect([...SUBSCRIPTION_KINDS]).toEqual([...NOTIFYING_EVENT_KINDS])
		for (const kind of SUBSCRIPTION_KINDS) {
			expect(isNotifyingEvent(kind)).toBe(true)
		}
	})

	it("does not offer a test as something to subscribe to", () => {
		expect([...SUBSCRIPTION_KINDS]).not.toContain(TEST_NOTIFICATION_KIND)
	})

	it("does not offer recoveries separately, because they follow their problem", () => {
		for (const kind of RESOLVING_EVENT_KINDS) {
			expect([...SUBSCRIPTION_KINDS]).not.toContain(kind)
		}
	})
})

describe("what can be sent", () => {
	it("covers every subscribable event, every recovery, and a test", () => {
		for (const kind of SUBSCRIPTION_KINDS) {
			expect([...NOTIFICATION_KINDS]).toContain(kind)
		}
		for (const kind of RESOLVING_EVENT_KINDS) {
			expect([...NOTIFICATION_KINDS]).toContain(kind)
		}
		expect([...NOTIFICATION_KINDS]).toContain(TEST_NOTIFICATION_KIND)
	})

	it("holds nothing else, so a quiet event can never be delivered", () => {
		expect(NOTIFICATION_KINDS).toHaveLength(
			NOTIFYING_EVENT_KINDS.length + RESOLVING_EVENT_KINDS.length + 1,
		)
		expect(new Set(NOTIFICATION_KINDS).size).toBe(NOTIFICATION_KINDS.length)
	})
})

describe("recoveries stay pinned to their problem", () => {
	it("resolves exactly the kinds declared as resolutions and no others", () => {
		for (const kind of STATUS_EVENT_KINDS) {
			const declared = RESOLVING_EVENT_KINDS.some((resolving) => resolving === kind)
			expect(problemResolvedBy(kind) !== undefined).toBe(declared)
		}
	})

	it("always resolves something a person actually asked to hear about", () => {
		for (const kind of RESOLVING_EVENT_KINDS) {
			const problem = problemResolvedBy(kind)
			expect(problem !== undefined && isNotifyingEvent(problem)).toBe(true)
		}
	})
})

describe("every connector is named for a person to read", () => {
	it("has a label", () => {
		for (const kind of DESTINATION_KINDS) {
			expect(DESTINATION_LABELS[kind].length).toBeGreaterThan(0)
		}
	})
})

describe("provider settings are checked before they are stored", () => {
	it("takes a Telegram topic as the number Telegram actually uses", () => {
		expect(
			telegramConfigInput.safeParse({ botToken: "t", chatId: "-100", messageThreadId: 42 }).success,
		).toBe(true)
		expect(
			telegramConfigInput.safeParse({ botToken: "t", chatId: "-100", messageThreadId: "42" })
				.success,
		).toBe(false)
		expect(telegramConfigInput.safeParse({ botToken: "t", chatId: "-100" }).success).toBe(true)
	})

	it("holds an ntfy topic to the characters ntfy accepts", () => {
		expect(
			ntfyConfigInput.safeParse({ serverUrl: "https://n.example", topic: "mcc_alerts-1" }),
		).toHaveProperty("success", true)
		for (const topic of ["has space", "has/slash", "emoji✅", "", "x".repeat(65)]) {
			expect(ntfyConfigInput.safeParse({ serverUrl: "https://n.example", topic }).success).toBe(
				false,
			)
		}
	})
})

describe("creating a destination", () => {
	const base = {
		name: "My webhook",
		destination: { kind: "webhook", config: { url: "https://hooks.example.com/x" } },
	}

	it("needs at least one thing to be told about", () => {
		expect(createDestinationInput.safeParse({ ...base, subscribedTo: [] }).success).toBe(false)
	})

	it("refuses the same alert twice, which the database would reject anyway", () => {
		expect(
			createDestinationInput.safeParse({
				...base,
				subscribedTo: ["host.unreachable", "host.unreachable"],
			}).success,
		).toBe(false)
	})

	it("accepts a distinct set", () => {
		expect(
			createDestinationInput.safeParse({
				...base,
				subscribedTo: ["host.unreachable", "instance.disconnected"],
			}).success,
		).toBe(true)
	})

	it("refuses an event nobody can subscribe to", () => {
		expect(
			createDestinationInput.safeParse({ ...base, subscribedTo: ["instance.kicked"] }).success,
		).toBe(false)
		expect(createDestinationInput.safeParse({ ...base, subscribedTo: ["test"] }).success).toBe(
			false,
		)
	})
})

describe("which secret a webhook is signed with", () => {
	const base = { url: "https://hooks.example.com/x", signingSecret: "whsec_CURRENT" }
	const now = new Date("2026-09-07T12:00:00Z")

	it("uses the current secret when there is only one", () => {
		expect(usableSigningSecrets(base, now)).toEqual(["whsec_CURRENT"])
	})

	it("signs with both during a rotation, so a receiver can catch up", () => {
		expect(
			usableSigningSecrets(
				{
					...base,
					previousSigningSecret: "whsec_OLD",
					previousSigningSecretExpiresAt: "2026-09-07T13:00:00.000Z",
				},
				now,
			),
		).toEqual(["whsec_CURRENT", "whsec_OLD"])
	})

	it("drops the old secret once its overlap has run out", () => {
		expect(
			usableSigningSecrets(
				{
					...base,
					previousSigningSecret: "whsec_OLD",
					previousSigningSecretExpiresAt: "2026-09-07T11:00:00.000Z",
				},
				now,
			),
		).toEqual(["whsec_CURRENT"])
	})

	it("ignores an old secret with no expiry, rather than honouring it forever", () => {
		expect(usableSigningSecrets({ ...base, previousSigningSecret: "whsec_OLD" }, now)).toEqual([
			"whsec_CURRENT",
		])
	})
})
