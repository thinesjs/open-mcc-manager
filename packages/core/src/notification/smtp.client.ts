import type { Socket } from "node:net"
import type { TLSSocket } from "node:tls"
import { networkReason } from "./failure"
import { classifyRefusal, classifySmtpReply, type DeliveryOutcome } from "./outcome"
import { needsStartTls } from "./smtp.connect"
import { messageBytes, type SmtpMessage } from "./smtp.message"
import {
	advertises,
	authMechanisms,
	isPositive,
	isTransient,
	readReply,
	type SmtpReply,
} from "./smtp.reply"

const INJECTED = "That mail server's reply looked tampered with"

const NO_TLS = "That mail server would not start a secure session"

const NO_AUTH = "That mail server does not accept the sign-in we support"

const CLOSED = "That mail server closed the connection"

const TOO_SLOW = "That mail server took too long"

const REFUSED = "That mail server refused the message"

const REFUSED_RECIPIENT = "That mail server refused one of the addresses"

const UNEXPECTED = "That mail server answered in a way we did not expect"

export type Reader = {
	readonly read: () => Promise<SmtpReply>
	readonly residual: () => string
	readonly stop: () => void
}

export const createReader = (socket: Socket): Reader => {
	let buffer = ""
	let waiting: { resolve: (reply: SmtpReply) => void; reject: (error: Error) => void } | undefined
	let failure: Error | undefined

	const deliver = () => {
		const pending = waiting
		if (!pending) return
		const parsed = readReply(buffer)
		if (!parsed.read) return
		buffer = parsed.rest
		waiting = undefined
		pending.resolve(parsed.reply)
	}

	const fail = (error: Error) => {
		failure = error
		const pending = waiting
		if (!pending) return
		waiting = undefined
		pending.reject(error)
	}

	const onData = (chunk: Buffer) => {
		buffer += chunk.toString("utf8")
		deliver()
	}
	const onError = (error: Error) => fail(error)
	const onEnd = () => fail(new Error(CLOSED))

	socket.on("data", onData)
	socket.on("error", onError)
	socket.on("end", onEnd)

	return {
		read: () =>
			new Promise<SmtpReply>((resolve, reject) => {
				if (failure) {
					reject(failure)
					return
				}
				waiting = { resolve, reject }
				deliver()
			}),
		residual: () => buffer,
		stop: () => {
			socket.removeListener("data", onData)
			socket.removeListener("error", onError)
			socket.removeListener("end", onEnd)
		},
	}
}

export type SmtpCredentials = {
	readonly hostname: string
	readonly port: number
	readonly username: string
	readonly password: string
}

export type Upgrade = (socket: Socket) => Promise<TLSSocket>

export type ConverseDeps = {
	readonly upgrade: Upgrade
	readonly timeoutMs: number
	readonly clientName?: string
}

const say = async (socket: Socket, line: string): Promise<void> => {
	await new Promise<void>((resolve, reject) => {
		socket.write(line, (error) => (error ? reject(error) : resolve()))
	})
}

const encoded = (value: string): string => Buffer.from(value, "utf8").toString("base64")

export const plainCredential = (username: string, password: string): string =>
	encoded(`\0${username}\0${password}`)

export const converse = async (
	connected: Socket,
	credentials: SmtpCredentials,
	message: SmtpMessage,
	deps: ConverseDeps,
): Promise<DeliveryOutcome> => {
	const name = deps.clientName ?? "openmcc"
	let socket = connected
	let reader = createReader(socket)

	const watch = (target: Socket) => {
		target.setTimeout(deps.timeoutMs, () => target.destroy(new Error(TOO_SLOW)))
	}
	watch(socket)

	const step = async (line: string): Promise<SmtpReply> => {
		await say(socket, line)
		return await reader.read()
	}

	try {
		const greeting = await reader.read()
		if (!isPositive(greeting)) return classifySmtpReply(greeting.code, UNEXPECTED)

		let capabilities = await step(`EHLO ${name}\r\n`)
		if (!isPositive(capabilities)) return classifySmtpReply(capabilities.code, UNEXPECTED)

		if (needsStartTls(credentials.port)) {
			if (!advertises(capabilities, "STARTTLS")) return classifyRefusal(NO_TLS)

			const ready = await step("STARTTLS\r\n")
			if (!isPositive(ready)) return classifySmtpReply(ready.code, NO_TLS)
			if (reader.residual() !== "") return classifyRefusal(INJECTED)

			reader.stop()
			socket.setTimeout(0)
			socket = await deps.upgrade(socket)
			watch(socket)
			reader = createReader(socket)

			capabilities = await step(`EHLO ${name}\r\n`)
			if (!isPositive(capabilities)) return classifySmtpReply(capabilities.code, UNEXPECTED)
		}

		const mechanisms = authMechanisms(capabilities)
		if (mechanisms.includes("PLAIN")) {
			const signedIn = await step(
				`AUTH PLAIN ${plainCredential(credentials.username, credentials.password)}\r\n`,
			)
			if (!isPositive(signedIn)) return classifySmtpReply(signedIn.code, NO_AUTH)
		} else if (mechanisms.includes("LOGIN")) {
			const asked = await step("AUTH LOGIN\r\n")
			if (asked.code !== 334) return classifySmtpReply(asked.code, NO_AUTH)
			const wantsPassword = await step(`${encoded(credentials.username)}\r\n`)
			if (wantsPassword.code !== 334) return classifySmtpReply(wantsPassword.code, NO_AUTH)
			const signedIn = await step(`${encoded(credentials.password)}\r\n`)
			if (!isPositive(signedIn)) return classifySmtpReply(signedIn.code, NO_AUTH)
		} else {
			return classifyRefusal(NO_AUTH)
		}

		const sender = await step(`MAIL FROM:<${message.from}>\r\n`)
		if (!isPositive(sender)) return classifySmtpReply(sender.code, REFUSED)

		const refusals: number[] = []
		for (const recipient of message.to) {
			const answer = await step(`RCPT TO:<${recipient}>\r\n`)
			if (!isPositive(answer)) refusals.push(answer.code)
		}
		if (refusals.length > 0) {
			const permanent = refusals.find((code) => !isTransient(code))
			return classifySmtpReply(permanent ?? refusals[0] ?? 550, REFUSED_RECIPIENT)
		}

		const opened = await step("DATA\r\n")
		if (opened.code !== 354) return classifySmtpReply(opened.code, REFUSED)

		const accepted = await step(`${messageBytes(message)}\r\n.\r\n`)
		if (!isPositive(accepted)) return classifySmtpReply(accepted.code, REFUSED)

		try {
			await say(socket, "QUIT\r\n")
		} catch {
			return { kind: "delivered", statusCode: accepted.code }
		}
		return { kind: "delivered", statusCode: accepted.code }
	} catch (error) {
		const raised = error instanceof Error ? error : undefined
		return {
			kind: "retryable",
			statusCode: undefined,
			reason: raised?.message === TOO_SLOW ? TOO_SLOW : networkReason(raised),
			retryAfterSeconds: undefined,
		}
	} finally {
		reader.stop()
		socket.destroy()
	}
}
