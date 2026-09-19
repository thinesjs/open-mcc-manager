import type { Socket } from "node:net"
import { DELIVERY_TIMEOUT_MS } from "@open-mcc/contracts"
import { assertExhaustive } from "../lib/exhaustive"
import { truncateChars } from "./bounds"
import { bareHostname, type EgressPolicy, PUBLIC_ONLY } from "./egress"
import { networkReason } from "./failure"
import { classifyNetworkFailure, classifyRefusal, type DeliveryOutcome } from "./outcome"
import { resolvePinned } from "./pinned"
import type { NotificationEnvelope } from "./sender"
import { converse, type Upgrade } from "./smtp.client"
import { needsStartTls, openPinned, upgrade as upgradeSocket } from "./smtp.connect"
import type { SmtpMessage } from "./smtp.message"

const NOWHERE = "that mail server could not be reached"

export const EMAIL_SUBJECT_CHARS = 250

export const EMAIL_TEXT_CHARS = 4000

export type EmailSettings = {
	readonly smtpServer: string
	readonly smtpPort: number
	readonly username: string
	readonly password: string
	readonly fromAddress: string
	readonly toAddresses: readonly string[]
}

export type SmtpDeps = {
	readonly policy?: EgressPolicy
	readonly timeoutMs?: number
	readonly resolve?: typeof resolvePinned
	readonly open?: typeof openPinned
	readonly secure?: Upgrade
	readonly speak?: typeof converse
	readonly now?: () => Date
}

export const emailMessage = (
	settings: EmailSettings,
	envelope: NotificationEnvelope,
	at: Date,
): SmtpMessage => ({
	id: envelope.deliveryId,
	from: settings.fromAddress,
	to: settings.toAddresses,
	subject: truncateChars(envelope.title, EMAIL_SUBJECT_CHARS),
	text: truncateChars(`${envelope.title}\n\n${envelope.body}`, EMAIL_TEXT_CHARS),
	at,
})

export const deliverEmail = async (
	settings: EmailSettings,
	envelope: NotificationEnvelope,
	deps: SmtpDeps = {},
): Promise<DeliveryOutcome> => {
	const policy = deps.policy ?? PUBLIC_ONLY
	const timeoutMs = deps.timeoutMs ?? DELIVERY_TIMEOUT_MS
	const resolve = deps.resolve ?? resolvePinned
	const open = deps.open ?? openPinned
	const speak = deps.speak ?? converse
	const at = (deps.now ?? (() => new Date()))()

	const hostname = bareHostname(settings.smtpServer).toLowerCase()
	const verdict = await resolve(hostname, policy)
	if (!verdict.pinned) return classifyRefusal(verdict.reason)

	const secure: Upgrade =
		deps.secure ?? ((socket: Socket) => upgradeSocket(socket, hostname, timeoutMs))

	let lastFailure: DeliveryOutcome = classifyRefusal(NOWHERE)

	for (const pinned of verdict.addresses) {
		let socket: Socket
		try {
			socket = await open({ address: pinned.address, port: settings.smtpPort, timeoutMs })
		} catch (error) {
			lastFailure = classifyNetworkFailure(
				networkReason(error instanceof Error ? error : undefined),
			)
			continue
		}

		if (!needsStartTls(settings.smtpPort)) {
			try {
				socket = await secure(socket)
			} catch (error) {
				socket.destroy()
				lastFailure = classifyNetworkFailure(
					networkReason(error instanceof Error ? error : undefined),
				)
				continue
			}
		}

		const conversation = await speak(
			socket,
			{
				hostname,
				port: settings.smtpPort,
				username: settings.username,
				password: settings.password,
			},
			emailMessage(settings, envelope, at),
			{ upgrade: secure, timeoutMs },
		)

		switch (conversation.kind) {
			case "settled":
				return conversation.outcome
			case "tryNextAddress":
				lastFailure = conversation.outcome
				break
			default:
				assertExhaustive(conversation)
		}
	}

	return lastFailure
}
