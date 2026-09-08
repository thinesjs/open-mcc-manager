import type { Socket } from "node:net"
import { afterEach, describe, expect, it } from "vitest"
import {
	type Answer,
	clientUpgrade,
	dial,
	EHLO_WITH_TLS,
	type Fake,
	HOSTNAME,
	serverSideTls,
	startFake,
} from "../test/smtp-fake"
import type { NotificationEnvelope } from "./sender"
import { deliverEmail, type EmailSettings } from "./smtp.sender"

const GREETING = "220 mail.example.com ESMTP\r\n"

const FIRST = "203.0.113.7"

const SECOND = "203.0.113.8"

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
	smtpServer: HOSTNAME,
	smtpPort: 587,
	username: "alerts",
	password: "s3cret",
	fromAddress: "alerts@example.com",
	toAddresses: ["on-call@example.com"],
}

const upTo =
	(recipient: (line: string) => Answer) =>
	(line: string): Answer => {
		const command = line.toUpperCase()
		if (command.startsWith("EHLO")) return { write: EHLO_WITH_TLS }
		if (command.startsWith("STARTTLS")) return { write: "220 go ahead\r\n", upgrade: true }
		if (command.startsWith("AUTH")) return { write: "235 authenticated\r\n" }
		if (command.startsWith("MAIL FROM")) return { write: "250 sender ok\r\n" }
		if (command.startsWith("RCPT TO")) return recipient(line)
		if (command.startsWith("DATA")) return { write: "354 go ahead\r\n" }
		if (command.startsWith("QUIT")) return { write: "221 bye\r\n" }
		return { write: "500 unknown\r\n" }
	}

const accepts = upTo(() => ({ write: "250 recipient ok\r\n" }))

const busy = upTo(() => ({ write: "450 mailbox busy\r\n" }))

const rejects = upTo(() => ({ write: "550 no such mailbox\r\n" }))

const acceptsOnlyTheFirst = upTo((line) =>
	line.includes("on-call@example.com")
		? { write: "250 recipient ok\r\n" }
		: { write: "550 no such mailbox\r\n" },
)

let fakes: Fake[] = []

const twoEndpoints = async (
	first: (line: string) => Answer,
	second: (line: string) => Answer,
): Promise<{ dialled: string[]; open: (target: { address: string }) => Promise<Socket> }> => {
	const one = await startFake(GREETING, first, serverSideTls)
	const two = await startFake(GREETING, second, serverSideTls)
	fakes = [one, two]
	const dialled: string[] = []
	return {
		dialled,
		open: async ({ address }) => {
			dialled.push(address)
			return await dial(address === FIRST ? one.port : two.port)
		},
	}
}

const bothAddresses = {
	pinned: true,
	addresses: [
		{ address: FIRST, family: 4, named: false },
		{ address: SECOND, family: 4, named: false },
	],
} as const

afterEach(async () => {
	for (const fake of fakes) await fake.close()
	fakes = []
})

describe("the real client driving the real sender across two addresses", () => {
	it("carries a transient refusal on to the second address and delivers there", async () => {
		const { dialled, open } = await twoEndpoints(busy, accepts)

		const outcome = await deliverEmail(settings, envelope, {
			resolve: async () => bothAddresses,
			open,
			secure: clientUpgrade,
		})

		expect(dialled).toEqual([FIRST, SECOND])
		expect(outcome).toEqual({ kind: "delivered", statusCode: 250 })
		expect(fakes[0]?.transcript).not.toContain("<message>")
		expect(fakes[1]?.transcript).toContain("<message>")
	})

	it("stops at the first address when that server refuses for good", async () => {
		const { dialled, open } = await twoEndpoints(rejects, accepts)

		const outcome = await deliverEmail(settings, envelope, {
			resolve: async () => bothAddresses,
			open,
			secure: clientUpgrade,
		})

		expect(dialled).toEqual([FIRST])
		expect(outcome.kind).toBe("terminal")
		expect(fakes[1]?.transcript).toEqual([])
	})

	it("never reopens the message elsewhere after a partial delivery", async () => {
		const { dialled, open } = await twoEndpoints(acceptsOnlyTheFirst, accepts)

		const outcome = await deliverEmail(
			{ ...settings, toAddresses: ["on-call@example.com", "typo@example.com"] },
			envelope,
			{ resolve: async () => bothAddresses, open, secure: clientUpgrade },
		)

		expect(dialled).toEqual([FIRST])
		expect(outcome.kind).toBe("terminal")
		expect(outcome.kind === "terminal" && outcome.stopSending).toBe(false)
		expect(fakes[0]?.transcript).toContain("<message>")
		expect(fakes[1]?.transcript).toEqual([])
	})
})
