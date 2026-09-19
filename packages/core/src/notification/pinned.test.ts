import { describe, expect, it } from "vitest"
import { egressPolicy, PUBLIC_ONLY } from "./egress"
import { type PinnedAddress, pinnedLookup, resolvePinned, sendPinned } from "./pinned"

const answering =
	(...addresses: string[]) =>
	async () =>
		addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }))

const policy = (settings: {
	allowedHosts?: string
	allowedAddresses?: string
	allowHttp?: boolean
}) =>
	egressPolicy({
		allowHttp: settings.allowHttp ?? false,
		allowedHosts: settings.allowedHosts ?? "",
		allowedAddresses: settings.allowedAddresses ?? "",
	})

describe("pinning what a name resolves to", () => {
	it("refuses the whole name when a single answer points somewhere private", async () => {
		const verdict = await resolvePinned(
			"push.example.com",
			PUBLIC_ONLY,
			answering("93.184.216.34", "10.0.0.7"),
		)

		expect(verdict.pinned).toBe(false)
	})

	it("takes every answer when they are all public", async () => {
		const verdict = await resolvePinned(
			"push.example.com",
			PUBLIC_ONLY,
			answering("93.184.216.34", "2606:2800:220:1::1"),
		)

		expect(verdict.pinned === true && verdict.addresses.map((entry) => entry.address)).toEqual([
			"93.184.216.34",
			"2606:2800:220:1::1",
		])
	})
})

describe("what an operator's named hosts do to pinning", () => {
	it("keeps every answer for a named host, private ones included", async () => {
		const verdict = await resolvePinned(
			"push.internal",
			policy({ allowedHosts: "push.internal" }),
			answering("10.0.0.7", "192.168.1.10"),
		)

		expect(verdict.pinned === true && verdict.addresses.map((entry) => entry.address)).toEqual([
			"10.0.0.7",
			"192.168.1.10",
		])
	})

	it("marks those answers named, so plain http stays a separate decision", async () => {
		const verdict = await resolvePinned(
			"push.internal",
			policy({ allowedHosts: "push.internal" }),
			answering("10.0.0.7"),
		)

		expect(verdict.pinned === true && verdict.addresses.every((entry) => entry.named)).toBe(true)
	})

	it("does not carry over to a host the operator did not name", async () => {
		const verdict = await resolvePinned(
			"other.internal",
			policy({ allowedHosts: "push.internal" }),
			answering("10.0.0.7"),
		)

		expect(verdict.pinned).toBe(false)
	})

	it("covers a host written as an address the operator named", async () => {
		const verdict = await resolvePinned("10.0.0.7", policy({ allowedHosts: "10.0.0.7" }))

		expect(verdict.pinned).toBe(true)
	})
})

describe("what an operator's named addresses do to pinning", () => {
	it("keeps an answer the operator named and refuses the rest of the range", async () => {
		const allowed = policy({ allowedAddresses: "10.0.0.7" })

		expect((await resolvePinned("push.example.com", allowed, answering("10.0.0.7"))).pinned).toBe(
			true,
		)
		expect((await resolvePinned("push.example.com", allowed, answering("10.0.0.8"))).pinned).toBe(
			false,
		)
	})

	it("keeps every answer inside a named range", async () => {
		const verdict = await resolvePinned(
			"push.example.com",
			policy({ allowedAddresses: "10.0.0.0/8" }),
			answering("10.0.0.7", "10.9.9.9"),
		)

		expect(verdict.pinned).toBe(true)
	})
})

describe("a DNS answer cannot be rebound to somewhere forbidden", () => {
	it("refuses the whole name when any answer is a metadata address, even for a named host", async () => {
		const verdict = await resolvePinned(
			"push.internal",
			policy({ allowedHosts: "push.internal" }),
			answering("10.0.0.7", "169.254.169.254"),
		)

		expect(verdict.pinned).toBe(false)
	})

	it("still refuses a name that resolves to nothing", async () => {
		const verdict = await resolvePinned("push.example.com", policy({}), () => Promise.resolve([]))

		expect(verdict.pinned).toBe(false)
	})
})

type LookupAnswer = { address: string; family: number }

describe("what the socket is actually handed", () => {
	const pinned = [
		{ address: "203.0.113.5", family: 4 as const, named: true },
		{ address: "2606:4700::1", family: 6 as const, named: true },
	]

	const askAll = (addresses: readonly PinnedAddress[]): LookupAnswer[] => {
		const seen: LookupAnswer[] = []
		pinnedLookup(addresses)("push.example.com", { all: true }, (error, value) => {
			if (error === null && Array.isArray(value)) seen.push(...value)
		})
		return seen
	}

	const askOne = (
		addresses: readonly PinnedAddress[],
		family?: number | "IPv4" | "IPv6",
	): LookupAnswer[] => {
		const seen: LookupAnswer[] = []
		pinnedLookup(addresses)(
			"push.example.com",
			family === undefined ? {} : { family },
			(error, address, answered) => {
				if (error === null && typeof address === "string") {
					seen.push({ address, family: answered ?? 0 })
				}
			},
		)
		return seen
	}

	it("hands back every approved address when asked for all of them", () => {
		expect(askAll(pinned)).toEqual([
			{ address: "203.0.113.5", family: 4 },
			{ address: "2606:4700::1", family: 6 },
		])
	})

	it("hands back a single address in the shape a plain lookup expects", () => {
		expect(askOne(pinned)).toEqual([{ address: "203.0.113.5", family: 4 }])
	})

	it("respects the family that was asked for, written either way", () => {
		for (const family of [6, "IPv6"] as const) {
			expect(askOne(pinned, family)[0]?.address).toBe("2606:4700::1")
		}
		for (const family of [4, "IPv4"] as const) {
			expect(askOne(pinned, family)[0]?.address).toBe("203.0.113.5")
		}
	})

	it("fails rather than inventing an address when the family cannot be met", () => {
		const errors: (Error | null)[] = []
		pinnedLookup([{ address: "203.0.113.5", family: 4, named: true }])(
			"push.example.com",
			{ family: 6 },
			(error) => {
				errors.push(error)
			},
		)

		expect(errors[0]).toBeInstanceOf(Error)
	})

	it("never hands over an address that was not approved", () => {
		expect(JSON.stringify(askAll(pinned))).not.toContain("127.0.0.1")
	})
})

describe("the deadline covers looking the name up, not just the connection", () => {
	const hanging = () => new Promise<readonly { address: string; family: number }[]>(() => {})

	it("gives up on a name that never resolves", async () => {
		const startedAt = Date.now()

		await expect(
			sendPinned({
				url: "https://push.example.com/hook",
				method: "POST",
				headers: {},
				body: "{}",
				timeoutMs: 200,
				lookupAddresses: hanging,
			}),
		).rejects.toThrow()

		expect(Date.now() - startedAt).toBeLessThan(2000)
	})

	it("refuses an address the policy rejects before it ever looks anything up", async () => {
		let asked = false
		const result = await sendPinned({
			url: "https://169.254.169.254/latest",
			method: "GET",
			headers: {},
			timeoutMs: 200,
			lookupAddresses: async () => {
				asked = true
				return []
			},
		})

		expect(result.sent).toBe(false)
		expect(asked).toBe(false)
	})
})
