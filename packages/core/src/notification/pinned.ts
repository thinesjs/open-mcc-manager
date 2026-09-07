import { lookup as lookupDns } from "node:dns/promises"
import type { IncomingHttpHeaders } from "node:http"
import { isIP, type LookupFunction } from "node:net"
import { DELIVERY_MAX_RESPONSE_BYTES, DELIVERY_TIMEOUT_MS } from "@open-mcc/contracts"
import { Agent, request as undiciRequest } from "undici"
import {
	bareHostname,
	type EgressPolicy,
	hostIsAllowed,
	PUBLIC_ONLY,
	verifyAddress,
	verifyDestinationUrl,
} from "./egress"

export type PinnedAddress = {
	readonly address: string
	readonly family: 4 | 6
	readonly named: boolean
}

export type PinVerdict =
	| { pinned: true; addresses: readonly PinnedAddress[] }
	| { pinned: false; reason: string }

export type AddressLookup = (
	hostname: string,
) => Promise<readonly { address: string; family: number }[]>

const NO_ANSWER = "that address could not be looked up"

const TOO_SLOW = "the delivery took too long"

const beforeDeadline = async <T>(work: Promise<T>, deadline: AbortSignal): Promise<T> => {
	if (deadline.aborted) throw new Error(TOO_SLOW)
	return await Promise.race([
		work,
		new Promise<T>((_resolve, reject) => {
			deadline.addEventListener("abort", () => reject(new Error(TOO_SLOW)), { once: true })
		}),
	])
}

const systemLookup: AddressLookup = async (hostname) =>
	await lookupDns(hostname, { all: true, verbatim: true })

export const resolvePinned = async (
	hostname: string,
	policy: EgressPolicy = PUBLIC_ONLY,
	lookupAddresses: AddressLookup = systemLookup,
): Promise<PinVerdict> => {
	const hostAllowed = hostIsAllowed(hostname, policy)
	const literal = isIP(hostname)
	if (literal !== 0) {
		const verdict = verifyAddress(hostname, policy, hostAllowed)
		if (!verdict.allowed) return { pinned: false, reason: verdict.reason }
		return {
			pinned: true,
			addresses: [{ address: hostname, family: literal === 4 ? 4 : 6, named: verdict.named }],
		}
	}

	let answers: readonly { address: string; family: number }[]
	try {
		answers = await lookupAddresses(hostname)
	} catch {
		return { pinned: false, reason: NO_ANSWER }
	}
	if (answers.length === 0) return { pinned: false, reason: NO_ANSWER }

	const pinned: PinnedAddress[] = []
	for (const answer of answers) {
		const family = isIP(answer.address)
		if (family === 0) return { pinned: false, reason: NO_ANSWER }
		const verdict = verifyAddress(answer.address, policy, hostAllowed)
		if (!verdict.allowed) return { pinned: false, reason: verdict.reason }
		pinned.push({ address: answer.address, family: family === 4 ? 4 : 6, named: verdict.named })
	}
	return { pinned: true, addresses: pinned }
}

const wantedFamily = (family: number | string | undefined): 4 | 6 | undefined => {
	if (family === 4 || family === "IPv4") return 4
	if (family === 6 || family === "IPv6") return 6
	return undefined
}

export const pinnedLookup =
	(addresses: readonly PinnedAddress[]): LookupFunction =>
	(_hostname, options, callback) => {
		const wanted = wantedFamily(options.family)
		const chosen =
			wanted === undefined ? addresses : addresses.filter((entry) => entry.family === wanted)
		const first = chosen[0]
		if (first === undefined) {
			callback(new Error(NO_ANSWER), [])
			return
		}
		if (options.all === true) {
			callback(
				null,
				chosen.map((entry) => ({ address: entry.address, family: entry.family })),
			)
			return
		}
		callback(null, first.address, first.family)
	}

export const pinnedAgent = (addresses: readonly PinnedAddress[], timeoutMs: number): Agent =>
	new Agent({
		connections: 1,
		pipelining: 0,
		headersTimeout: timeoutMs,
		bodyTimeout: timeoutMs,
		maxResponseSize: DELIVERY_MAX_RESPONSE_BYTES,
		connect: { timeout: timeoutMs, lookup: pinnedLookup(addresses) },
	})

export type PinnedRequest = {
	readonly url: string
	readonly method: "GET" | "POST"
	readonly headers: Readonly<Record<string, string>>
	readonly body?: string
	readonly timeoutMs?: number
	readonly policy?: EgressPolicy
	readonly lookupAddresses?: AddressLookup
}

export type PinnedResult =
	| { sent: true; status: number; headers: Readonly<Record<string, string>>; body: string }
	| { sent: false; reason: string }

const flatten = (headers: IncomingHttpHeaders): Record<string, string> => {
	const out: Record<string, string> = {}
	for (const [key, value] of Object.entries(headers)) {
		if (typeof value === "string") out[key] = value
		else if (Array.isArray(value)) out[key] = value.join(", ")
	}
	return out
}

export const sendPinned = async (request: PinnedRequest): Promise<PinnedResult> => {
	const policy = request.policy ?? PUBLIC_ONLY
	const timeoutMs = request.timeoutMs ?? DELIVERY_TIMEOUT_MS
	const deadline = AbortSignal.timeout(timeoutMs)

	const target = verifyDestinationUrl(request.url, policy)
	if (!target.allowed) return { sent: false, reason: target.reason }

	const pin = await beforeDeadline(
		resolvePinned(bareHostname(target.hostname), policy, request.lookupAddresses ?? systemLookup),
		deadline,
	)
	if (!pin.pinned) return { sent: false, reason: pin.reason }

	if (new URL(request.url).protocol === "http:" && !pin.addresses.every((entry) => entry.named)) {
		return { sent: false, reason: "the address must start with https" }
	}

	const agent = pinnedAgent(pin.addresses, timeoutMs)
	try {
		const response = await undiciRequest(request.url, {
			dispatcher: agent,
			method: request.method,
			headers: request.headers,
			signal: deadline,
			...(request.body === undefined ? {} : { body: request.body }),
		})
		const body = await response.body.text()
		return { sent: true, status: response.statusCode, headers: flatten(response.headers), body }
	} finally {
		await agent.destroy()
	}
}
