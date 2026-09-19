import { createConnection, isIP, type Socket } from "node:net"
import { connect as startTls, type TLSSocket } from "node:tls"
import { InternalError } from "../lib/errors"

export const IMPLICIT_TLS_PORT = 465

export type SecureOptions =
	| { readonly socket: Socket; readonly servername: string; readonly rejectUnauthorized: true }
	| { readonly socket: Socket; readonly host: string; readonly rejectUnauthorized: true }

export const secureOptions = (socket: Socket, hostname: string): SecureOptions =>
	isIP(hostname) === 0
		? { socket, servername: hostname, rejectUnauthorized: true }
		: { socket, host: hostname, rejectUnauthorized: true }

export const needsStartTls = (port: number): boolean => port !== IMPLICIT_TLS_PORT

export type PlainConnect = (options: { host: string; port: number }) => Socket

export type SecureUpgrade = (options: SecureOptions) => TLSSocket

const settled = <T extends Socket>(
	socket: T,
	ready: string,
	timeoutMs: number,
	failure: string,
): Promise<T> =>
	new Promise((resolve, reject) => {
		const done = (outcome: () => void) => {
			socket.removeListener(ready, onReady)
			socket.removeListener("error", onError)
			socket.removeListener("timeout", onTimeout)
			outcome()
		}
		const onReady = () => done(() => resolve(socket))
		const onError = (error: Error) => done(() => reject(error))
		const onTimeout = () =>
			done(() => {
				socket.destroy()
				reject(new InternalError(failure))
			})
		socket.setTimeout(timeoutMs)
		socket.once(ready, onReady)
		socket.once("error", onError)
		socket.once("timeout", onTimeout)
	})

export const openPinned = async (
	pinned: { address: string; port: number; timeoutMs: number },
	create: PlainConnect = createConnection,
): Promise<Socket> => {
	const socket = create({ host: pinned.address, port: pinned.port })
	return await settled(socket, "connect", pinned.timeoutMs, "the mail server did not answer")
}

export const upgrade = async (
	socket: Socket,
	hostname: string,
	timeoutMs: number,
	secure: SecureUpgrade = startTls,
): Promise<TLSSocket> => {
	const upgraded = secure(secureOptions(socket, hostname))
	return await settled(upgraded, "secureConnect", timeoutMs, "the secure connection timed out")
}
