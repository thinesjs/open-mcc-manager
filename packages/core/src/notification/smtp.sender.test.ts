import { Socket } from "node:net"
import { TLSSocket } from "node:tls"
import { describe, expect, it } from "vitest"
import { egressPolicy } from "./egress"
import type { DeliveryOutcome } from "./outcome"
import type { NotificationEnvelope } from "./sender"
import { deliverEmail, type EmailSettings, emailMessage } from "./smtp.sender"

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

const settings: EmailSettings = {
	smtpServer: "smtp.example.com",
	smtpPort: 587,
	username: "alerts",
	password: "s3cret",
	fromAddress: "alerts@example.com",
	toAddresses: ["on-call@example.com"],
}

const delivered: DeliveryOutcome = { kind: "delivered", statusCode: 250 }

const nowhere = { pinned: false, reason: "it points at a private network" } as const

const socketStub = (): Socket => new Socket()

const secureStub = (socket: Socket): TLSSocket => new TLSSocket(socket)

describe("who the mail sender is willing to talk to", () => {
	it("never opens a socket when the address is not approved", async () => {
		const dialled: string[] = []

		const outcome = await deliverEmail(settings, envelope, {
			resolve: async () => nowhere,
			open: async ({ address }) => {
				dialled.push(address)
				throw new Error("should not have dialled")
			},
		})

		expect(dialled).toEqual([])
		expect(outcome.kind).toBe("terminal")
		expect(outcome.kind === "terminal" && outcome.reason).toBe("it points at a private network")
	})

	it("dials the approved address, not the hostname", async () => {
		const dialled: string[] = []
		const spokenTo: string[] = []

		await deliverEmail(settings, envelope, {
			resolve: async () => ({
				pinned: true,
				addresses: [{ address: "203.0.113.7", family: 4, named: false }],
			}),
			open: async ({ address }) => {
				dialled.push(address)
				return socketStub()
			},
			speak: async (_socket, credentials) => {
				spokenTo.push(credentials.hostname)
				return delivered
			},
		})

		expect(dialled).toEqual(["203.0.113.7"])
		expect(spokenTo).toEqual(["smtp.example.com"])
	})

	it("moves on to the next approved address when one will not answer", async () => {
		const dialled: string[] = []

		const outcome = await deliverEmail(settings, envelope, {
			resolve: async () => ({
				pinned: true,
				addresses: [
					{ address: "203.0.113.7", family: 4, named: false },
					{ address: "203.0.113.8", family: 4, named: false },
				],
			}),
			open: async ({ address }) => {
				dialled.push(address)
				if (address === "203.0.113.7") throw new Error("refused")
				return socketStub()
			},
			speak: async () => delivered,
		})

		expect(dialled).toEqual(["203.0.113.7", "203.0.113.8"])
		expect(outcome.kind).toBe("delivered")
	})

	it("reports a server that never answers as worth retrying", async () => {
		const outcome = await deliverEmail(settings, envelope, {
			resolve: async () => ({
				pinned: true,
				addresses: [{ address: "203.0.113.7", family: 4, named: false }],
			}),
			open: async () => {
				throw new Error("timed out")
			},
		})

		expect(outcome.kind).toBe("retryable")
		expect(outcome.kind === "retryable" && outcome.reason).toBe("The delivery did not go through")
	})

	it("secures the socket before the greeting on the implicit-TLS port", async () => {
		const order: string[] = []

		await deliverEmail({ ...settings, smtpPort: 465 }, envelope, {
			resolve: async () => ({
				pinned: true,
				addresses: [{ address: "203.0.113.7", family: 4, named: false }],
			}),
			open: async () => {
				order.push("open")
				return socketStub()
			},
			secure: async (socket) => {
				order.push("secure")
				return secureStub(socket)
			},
			speak: async () => {
				order.push("speak")
				return delivered
			},
		})

		expect(order).toEqual(["open", "secure", "speak"])
	})

	it("leaves the securing to the conversation on a STARTTLS port", async () => {
		const order: string[] = []

		await deliverEmail(settings, envelope, {
			resolve: async () => ({
				pinned: true,
				addresses: [{ address: "203.0.113.7", family: 4, named: false }],
			}),
			open: async () => {
				order.push("open")
				return socketStub()
			},
			secure: async (socket) => {
				order.push("secure")
				return secureStub(socket)
			},
			speak: async () => {
				order.push("speak")
				return delivered
			},
		})

		expect(order).toEqual(["open", "speak"])
	})

	it("honours an operator's allowance for their own network", async () => {
		const dialled: string[] = []
		const policy = egressPolicy({
			allowHttp: false,
			allowedHosts: "",
			allowedAddresses: "192.168.4.0/24",
		})

		await deliverEmail({ ...settings, smtpServer: "192.168.4.9" }, envelope, {
			policy,
			open: async ({ address }) => {
				dialled.push(address)
				return socketStub()
			},
			speak: async () => delivered,
		})

		expect(dialled).toEqual(["192.168.4.9"])
	})

	it("still refuses a private address the operator has not allowed", async () => {
		const dialled: string[] = []

		const outcome = await deliverEmail({ ...settings, smtpServer: "192.168.4.9" }, envelope, {
			open: async ({ address }) => {
				dialled.push(address)
				return socketStub()
			},
			speak: async () => delivered,
		})

		expect(dialled).toEqual([])
		expect(outcome.kind).toBe("terminal")
	})
})

describe("the message an operator receives", () => {
	it("carries the delivery id as stable message identity across retries", () => {
		const built = emailMessage(settings, envelope, new Date("2026-09-07T12:00:05Z"))
		expect(built.id).toBe("dlv_xyz789")
	})

	it("leads with the title and keeps the body underneath", () => {
		const built = emailMessage(settings, envelope, new Date("2026-09-07T12:00:05Z"))
		expect(built.subject).toBe("steve-bot left the server")
		expect(built.text).toBe("steve-bot left the server\n\nIt has not come back on its own.")
	})

	it("bounds an absurd alert rather than sending it whole", () => {
		const huge: NotificationEnvelope = {
			...envelope,
			title: "t".repeat(5000),
			body: "b".repeat(50_000),
		}
		const built = emailMessage(settings, huge, new Date())
		expect(Array.from(built.subject)).toHaveLength(250)
		expect(Array.from(built.text)).toHaveLength(4000)
	})
})

describe("what an operator is told when the connection itself fails", () => {
	const pinnedOnce = {
		resolve: async () => ({
			pinned: true as const,
			addresses: [{ address: "203.0.113.7", family: 4 as const, named: false }],
		}),
	}

	it("names a refused connection rather than calling it unreachable", async () => {
		const outcome = await deliverEmail(settings, envelope, {
			...pinnedOnce,
			open: async () => {
				throw Object.assign(new Error("connect ECONNREFUSED 203.0.113.7:587"), {
					code: "ECONNREFUSED",
				})
			},
		})

		expect(outcome.kind === "retryable" && outcome.reason).toBe(
			"That address refused the connection",
		)
	})

	it("names an untrusted certificate on the implicit-TLS port instead of hiding it", async () => {
		const outcome = await deliverEmail({ ...settings, smtpPort: 465 }, envelope, {
			...pinnedOnce,
			open: async () => socketStub(),
			secure: async () => {
				throw Object.assign(new Error("self signed certificate"), {
					code: "DEPTH_ZERO_SELF_SIGNED_CERT",
				})
			},
		})

		expect(outcome.kind === "retryable" && outcome.reason).toBe(
			"That address presented a certificate we could not trust",
		)
	})

	it("reports the last address it tried when every one of them fails", async () => {
		const dialled: string[] = []

		const outcome = await deliverEmail(settings, envelope, {
			resolve: async () => ({
				pinned: true as const,
				addresses: [
					{ address: "203.0.113.7", family: 4 as const, named: false },
					{ address: "203.0.113.8", family: 4 as const, named: false },
				],
			}),
			open: async ({ address }) => {
				dialled.push(address)
				throw address === "203.0.113.7"
					? Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" })
					: Object.assign(new Error("connect ETIMEDOUT"), { code: "ETIMEDOUT" })
			},
		})

		expect(dialled).toEqual(["203.0.113.7", "203.0.113.8"])
		expect(outcome.kind === "retryable" && outcome.reason).toBe(
			"That address did not answer in time",
		)
	})

	it("still never repeats the address it could not reach", async () => {
		const outcome = await deliverEmail(settings, envelope, {
			...pinnedOnce,
			open: async () => {
				throw Object.assign(new Error("connect ETIMEDOUT 203.0.113.7:587"), {
					code: "ETIMEDOUT",
				})
			},
		})

		const reason = outcome.kind === "retryable" ? outcome.reason : ""
		expect(reason).not.toMatch(/\d+\.\d+\.\d+\.\d+|:\d{2,5}\b/)
	})
})
