import { isIP } from "node:net"
import type { RejectionCategory } from "@open-mcc/contracts"

export type AddressAllowance = {
	readonly bytes: readonly number[]
	readonly bits: number
}

export type EgressPolicy = {
	readonly allowHttp: boolean
	readonly allowedHosts: readonly string[]
	readonly allowedAddresses: readonly AddressAllowance[]
}

export const PUBLIC_ONLY: EgressPolicy = {
	allowHttp: false,
	allowedHosts: [],
	allowedAddresses: [],
}

export type { RejectionCategory }

export type AddressVerdict =
	| { allowed: true; named: boolean }
	| { allowed: false; reason: string; category: RejectionCategory }

const LOOPBACK = "it points back at this machine"
const PRIVATE = "it points at a private network"
const RESERVED = "it points at a reserved address"
const UNREADABLE = "that address could not be read"

const V6_GROUPS = 8
const HEXTET = /^[0-9a-fA-F]{1,4}$/
const WIDTH = /^\d{1,3}$/

export const bareHostname = (hostname: string): string => hostname.replace(/^\[|\]$/g, "")

const LOCAL_SUFFIXES = [".localhost", ".local", ".internal", ".home.arpa"]

export const looksLocalName = (hostname: string): boolean =>
	hostname === "localhost" || LOCAL_SUFFIXES.some((suffix) => hostname.endsWith(suffix))

const parseV4 = (address: string): number[] | undefined => {
	const parts = address.split(".")
	if (parts.length !== 4) return undefined
	const bytes: number[] = []
	for (const part of parts) {
		if (!/^\d{1,3}$/.test(part)) return undefined
		const byte = Number(part)
		if (byte > 255) return undefined
		bytes.push(byte)
	}
	return bytes
}

const hextetsOf = (segment: string): number[] | undefined => {
	if (segment.length === 0) return []
	const groups = segment.split(":")
	const out: number[] = []
	for (const [index, group] of groups.entries()) {
		if (index === groups.length - 1 && group.includes(".")) {
			const embedded = parseV4(group)
			if (!embedded) return undefined
			const [a, b, c, d] = embedded
			if (a === undefined || b === undefined || c === undefined || d === undefined) {
				return undefined
			}
			out.push((a << 8) | b, (c << 8) | d)
			continue
		}
		if (!HEXTET.test(group)) return undefined
		out.push(Number.parseInt(group, 16))
	}
	return out
}

const octetsOf = (groups: readonly number[]): number[] =>
	groups.flatMap((group) => [(group >> 8) & 0xff, group & 0xff])

const parseV6 = (address: string): number[] | undefined => {
	if (address.includes("%")) return undefined
	const halves = address.split("::")
	if (halves.length > 2) return undefined
	if (halves.length === 2) {
		const head = hextetsOf(halves[0] ?? "")
		const tail = hextetsOf(halves[1] ?? "")
		if (!head || !tail) return undefined
		const gap = V6_GROUPS - head.length - tail.length
		if (gap < 1) return undefined
		return octetsOf([...head, ...new Array<number>(gap).fill(0), ...tail])
	}
	const only = hextetsOf(halves[0] ?? "")
	if (!only || only.length !== V6_GROUPS) return undefined
	return octetsOf(only)
}

const parseAddress = (address: string): number[] | undefined => {
	const family = isIP(address)
	if (family === 4) return parseV4(address)
	if (family === 6) return parseV6(address)
	return undefined
}

type Range = AddressAllowance & { readonly reason: string; readonly category: RejectionCategory }

const allowanceOf = (notation: string): AddressAllowance | undefined => {
	const slash = notation.indexOf("/")
	const written = slash === -1 ? notation : notation.slice(0, slash)
	const bytes = parseAddress(bareHostname(written))
	if (!bytes) return undefined
	if (slash === -1) return { bytes, bits: bytes.length * 8 }
	const width = notation.slice(slash + 1)
	if (!WIDTH.test(width)) return undefined
	const bits = Number(width)
	if (bits > bytes.length * 8) return undefined
	return { bytes, bits }
}

const CATEGORY_OF: Record<string, RejectionCategory> = {
	[LOOPBACK]: "loopback",
	[PRIVATE]: "private",
	[RESERVED]: "reserved",
	[UNREADABLE]: "unreadable",
}

const categoryFor = (reason: string): RejectionCategory => CATEGORY_OF[reason] ?? "reserved"

const range = (notation: string, reason: string): Range => {
	const allowance = allowanceOf(notation)
	if (!allowance) throw new Error(`unusable address range: ${notation}`)
	return { ...allowance, reason, category: categoryFor(reason) }
}

const within = (bytes: readonly number[], limit: AddressAllowance): boolean => {
	if (bytes.length !== limit.bytes.length) return false
	if (limit.bits > limit.bytes.length * 8) return false
	let remaining = limit.bits
	let index = 0
	while (remaining > 0) {
		const width = Math.min(8, remaining)
		const mask = (0xff << (8 - width)) & 0xff
		const left = bytes[index]
		const right = limit.bytes[index]
		if (left === undefined || right === undefined) return false
		if ((left & mask) !== (right & mask)) return false
		remaining -= width
		index += 1
	}
	return true
}

const NEVER_V4: readonly Range[] = [
	range("0.0.0.0/8", LOOPBACK),
	range("169.254.0.0/16", RESERVED),
	range("224.0.0.0/4", RESERVED),
	range("240.0.0.0/4", RESERVED),
	range("100.100.100.100/32", RESERVED),
	range("100.100.100.200/32", RESERVED),
	range("192.0.0.192/32", RESERVED),
]

const NEVER_V6: readonly Range[] = [
	range("::/128", LOOPBACK),
	range("ff00::/8", RESERVED),
	range("fe80::/10", RESERVED),
	range("fd00:ec2::254/128", RESERVED),
]

const FORBIDDEN_V4: readonly Range[] = [
	range("10.0.0.0/8", PRIVATE),
	range("100.64.0.0/10", PRIVATE),
	range("127.0.0.0/8", LOOPBACK),
	range("172.16.0.0/12", PRIVATE),
	range("192.0.0.0/24", RESERVED),
	range("192.0.2.0/24", RESERVED),
	range("192.88.99.0/24", RESERVED),
	range("192.168.0.0/16", PRIVATE),
	range("198.18.0.0/15", RESERVED),
	range("198.51.100.0/24", RESERVED),
	range("203.0.113.0/24", RESERVED),
]

const GLOBAL_V6 = range("2000::/3", RESERVED)

const MAPPED_V4 = range("::ffff:0:0/96", RESERVED)

const NON_GLOBAL_V6: readonly Range[] = [
	range("::1/128", LOOPBACK),
	range("fc00::/7", PRIVATE),
	range("fec0::/10", PRIVATE),
]

const FORBIDDEN_V6: readonly Range[] = [
	range("2001::/32", RESERVED),
	range("2001:2::/48", RESERVED),
	range("2001:10::/28", RESERVED),
	range("2001:20::/28", RESERVED),
	range("2001:db8::/32", RESERVED),
	range("2002::/16", RESERVED),
	range("3fff::/20", RESERVED),
]

const softDeny = (bytes: readonly number[]): Range | undefined => {
	if (bytes.length === 4) return FORBIDDEN_V4.find((limit) => within(bytes, limit))
	if (!within(bytes, GLOBAL_V6)) {
		return NON_GLOBAL_V6.find((limit) => within(bytes, limit)) ?? GLOBAL_V6
	}
	return FORBIDDEN_V6.find((limit) => within(bytes, limit))
}

const normalised = (bytes: readonly number[]): readonly number[] =>
	bytes.length === 16 && within(bytes, MAPPED_V4) ? bytes.slice(12) : bytes

export const verifyAddress = (
	address: string,
	policy: EgressPolicy = PUBLIC_ONLY,
	hostAllowed = false,
): AddressVerdict => {
	const parsed = parseAddress(address)
	if (!parsed) return { allowed: false, reason: UNREADABLE, category: "unreadable" }
	const bytes = normalised(parsed)

	const never = (bytes.length === 4 ? NEVER_V4 : NEVER_V6).find((limit) => within(bytes, limit))
	if (never) return { allowed: false, reason: never.reason, category: never.category }

	const named = hostAllowed || policy.allowedAddresses.some((allowance) => within(bytes, allowance))
	const hit = softDeny(bytes)
	if (!hit) return { allowed: true, named }
	if (named) return { allowed: true, named: true }
	return { allowed: false, reason: hit.reason, category: hit.category }
}

export const hostIsAllowed = (hostname: string, policy: EgressPolicy): boolean =>
	policy.allowedHosts.includes(bareHostname(hostname).toLowerCase())

export type UrlVerdict =
	| { allowed: true; hostname: string }
	| { allowed: false; reason: string; category: RejectionCategory }

const INSECURE = "the address must start with https"

export const verifyDestinationUrl = (
	raw: string,
	policy: EgressPolicy = PUBLIC_ONLY,
): UrlVerdict => {
	let parsed: URL
	try {
		parsed = new URL(raw)
	} catch {
		return {
			allowed: false,
			reason: "that does not look like a web address",
			category: "unreadable",
		}
	}
	if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
		return { allowed: false, reason: INSECURE, category: "insecure" }
	}
	if (parsed.username.length > 0 || parsed.password.length > 0) {
		return {
			allowed: false,
			reason: "the address must not contain a username or password",
			category: "credentials",
		}
	}
	if (parsed.hash.length > 0) {
		return {
			allowed: false,
			reason: "the address must not contain a fragment",
			category: "fragment",
		}
	}

	const hostname = bareHostname(parsed.hostname)
	if (hostname.length === 0) {
		return {
			allowed: false,
			reason: "that does not look like a web address",
			category: "unreadable",
		}
	}

	const hostAllowed = hostIsAllowed(hostname, policy)
	const literal = isIP(hostname) !== 0
	const verdict = literal ? verifyAddress(hostname, policy, hostAllowed) : undefined

	if (verdict && !verdict.allowed) {
		return { allowed: false, reason: verdict.reason, category: verdict.category }
	}
	if (!hostAllowed && !literal && looksLocalName(hostname)) {
		return { allowed: false, reason: LOOPBACK, category: "loopback" }
	}

	if (parsed.protocol === "http:") {
		const named = hostAllowed || (verdict?.allowed === true && verdict.named)
		if (!policy.allowHttp || !named) {
			return { allowed: false, reason: INSECURE, category: "insecure" }
		}
	}

	return { allowed: true, hostname: parsed.hostname }
}

export const sanitisedTarget = (raw: string): string => {
	try {
		const parsed = new URL(raw)
		return parsed.pathname === "/" || parsed.pathname.length === 0
			? parsed.origin
			: `${parsed.origin}/…`
	} catch {
		return "an address that could not be read"
	}
}

export type EgressSettings = {
	readonly allowHttp: boolean
	readonly allowedHosts: string
	readonly allowedAddresses: string
}

const listed = (raw: string): string[] =>
	raw
		.split(",")
		.map((entry) => entry.trim().toLowerCase())
		.filter((entry) => entry.length > 0)

export const readsAsAddressList = (raw: string): boolean =>
	listed(raw).every((entry) => allowanceOf(entry) !== undefined)

export const egressPolicy = (settings: EgressSettings): EgressPolicy => ({
	allowHttp: settings.allowHttp,
	allowedHosts: listed(settings.allowedHosts).map(bareHostname),
	allowedAddresses: listed(settings.allowedAddresses).map((entry) => {
		const allowance = allowanceOf(entry)
		if (!allowance) throw new Error(`that address could not be read: ${entry}`)
		return allowance
	}),
})
