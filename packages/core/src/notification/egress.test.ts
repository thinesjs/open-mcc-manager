import { describe, expect, it } from "vitest"
import {
	egressPolicy,
	hostIsAllowed,
	PUBLIC_ONLY,
	readsAsAddressList,
	sanitisedTarget,
	verifyAddress,
	verifyDestinationUrl,
} from "./egress"

const denied = (address: string) => verifyAddress(address).allowed === false
const permitted = (address: string) => verifyAddress(address).allowed === true

describe("IPv4, the ordinary spellings", () => {
	it.each([
		"0.0.0.0",
		"10.0.0.1",
		"10.255.255.254",
		"100.64.0.1",
		"100.127.255.254",
		"127.0.0.1",
		"127.1.2.3",
		"169.254.169.254",
		"172.16.0.1",
		"172.31.255.254",
		"192.0.0.1",
		"192.0.2.1",
		"192.88.99.2",
		"192.168.1.1",
		"198.18.0.1",
		"198.19.255.254",
		"198.51.100.1",
		"203.0.113.1",
		"224.0.0.1",
		"239.255.255.255",
		"240.0.0.1",
		"255.255.255.255",
	])("refuses %s", (address) => {
		expect(denied(address)).toBe(true)
	})

	it.each([
		"8.8.8.8",
		"1.1.1.1",
		"172.15.255.254",
		"172.32.0.1",
		"100.63.255.254",
		"100.128.0.1",
		"192.0.1.1",
		"192.0.3.1",
		"192.88.98.1",
		"192.88.100.1",
		"198.17.255.254",
		"198.20.0.1",
		"223.255.255.254",
	])("allows %s", (address) => {
		expect(permitted(address)).toBe(true)
	})

	it("draws the 172.16/12 boundary exactly where the registry does", () => {
		expect(permitted("172.15.255.255")).toBe(true)
		expect(denied("172.16.0.0")).toBe(true)
		expect(denied("172.31.255.255")).toBe(true)
		expect(permitted("172.32.0.0")).toBe(true)
	})
})

describe("IPv6, including the spellings that used to slip through", () => {
	it.each([
		"::1",
		"0:0:0:0:0:0:0:1",
		"0000:0000:0000:0000:0000:0000:0000:0001",
		"::",
		"0:0:0:0:0:0:0:0",
		"fe80::1",
		"fe80:0:0:0:0:0:0:1",
		"fc00::1",
		"fd12:3456::1",
		"fec0::1",
		"ff02::1",
		"ff00::1",
		"64:ff9b::1",
		"64:ff9b:1::1",
		"100::1",
		"100:0:0:1::1",
		"2001::1",
		"2001:0:1234::1",
		"2001:2::1",
		"2001:10::1",
		"2001:20::1",
		"2001:db8::1",
		"2002::1",
		"3fff::1",
		"5f00::1",
		"4000::1",
		"c000::1",
	])("refuses %s", (address) => {
		expect(denied(address)).toBe(true)
	})

	it.each([
		"2606:4700:4700::1111",
		"2001:4860:4860::8888",
		"2400:cb00::1",
		"3ffe::1",
		"2003::1",
		"2001:db9::1",
		"2001:3::1",
	])("allows %s", (address) => {
		expect(permitted(address)).toBe(true)
	})

	it("unmasks IPv4 hiding inside IPv6, however it is written", () => {
		expect(denied("::ffff:127.0.0.1")).toBe(true)
		expect(denied("0:0:0:0:0:ffff:127.0.0.1")).toBe(true)
		expect(denied("::ffff:7f00:1")).toBe(true)
		expect(denied("::ffff:169.254.169.254")).toBe(true)
		expect(denied("0:0:0:0:0:ffff:169.254.169.254")).toBe(true)
		expect(denied("::ffff:a9fe:a9fe")).toBe(true)
		expect(denied("::ffff:10.0.0.1")).toBe(true)
		expect(denied("::ffff:192.168.1.1")).toBe(true)
		expect(permitted("::ffff:8.8.8.8")).toBe(true)
	})

	it("refuses a zone identifier rather than reading past it", () => {
		expect(denied("fe80::1%eth0")).toBe(true)
		expect(denied("::1%lo0")).toBe(true)
	})

	it("refuses anything it cannot read, rather than waving it through", () => {
		expect(denied("not-an-address")).toBe(true)
		expect(denied("")).toBe(true)
		expect(denied("1:2:3")).toBe(true)
		expect(denied("::ffff:999.0.0.1")).toBe(true)
		expect(denied("1::2::3")).toBe(true)
	})

	it("is fail-closed: everything outside allocated global space is refused", () => {
		expect(denied("0100::1")).toBe(true)
		expect(denied("8000::1")).toBe(true)
		expect(denied("fffe::1")).toBe(true)
	})
})

describe("addresses nothing can open, however the operator asks", () => {
	const named = (entry: string) =>
		egressPolicy({ allowHttp: true, allowedHosts: "", allowedAddresses: entry })

	it.each([
		"169.254.169.254",
		"169.254.0.1",
		"100.100.100.100",
		"100.100.100.200",
		"192.0.0.192",
		"0.0.0.0",
		"224.0.0.1",
		"239.255.255.255",
		"255.255.255.255",
		"240.0.0.1",
		"::",
		"ff02::1",
		"fe80::1",
		"fd00:ec2::254",
	])("refuses %s even when it is named outright", (address) => {
		expect(verifyAddress(address).allowed).toBe(false)
		expect(verifyAddress(address, named(address)).allowed).toBe(false)
	})

	it("refuses the metadata address hidden inside an IPv6 spelling", () => {
		expect(verifyAddress("::ffff:169.254.169.254", named("169.254.169.254")).allowed).toBe(false)
		expect(verifyAddress("::ffff:a9fe:a9fe", named("::ffff:169.254.169.254")).allowed).toBe(false)
	})

	it("refuses them through a named host too", () => {
		const policy = egressPolicy({
			allowHttp: true,
			allowedHosts: "metadata.example",
			allowedAddresses: "",
		})
		expect(verifyAddress("169.254.169.254", policy, true).allowed).toBe(false)
	})
})

describe("the address a person actually types", () => {
	it.each([
		"https://0177.0.0.1/hook",
		"https://2130706433/hook",
		"https://0x7f000001/hook",
		"https://127.1/hook",
		"https://[::1]/hook",
		"https://[0:0:0:0:0:ffff:127.0.0.1]/hook",
		"https://[::ffff:169.254.169.254]/hook",
		"https://169.254.169.254/latest/meta-data",
		"https://192.168.0.5/hook",
	])("refuses %s", (raw) => {
		expect(verifyDestinationUrl(raw).allowed).toBe(false)
	})

	it("refuses a name that can only mean this network", () => {
		for (const raw of [
			"https://localhost/hook",
			"https://gotify.localhost/hook",
			"https://nas.local/hook",
			"https://api.internal/hook",
			"https://box.home.arpa/hook",
		]) {
			expect(verifyDestinationUrl(raw).allowed).toBe(false)
		}
	})

	it("refuses plain http, credentials and fragments", () => {
		expect(verifyDestinationUrl("http://hooks.example.com/x").allowed).toBe(false)
		expect(verifyDestinationUrl("https://user:pass@hooks.example.com/x").allowed).toBe(false)
		expect(verifyDestinationUrl("https://hooks.example.com/x#part").allowed).toBe(false)
		expect(verifyDestinationUrl("ftp://hooks.example.com/x").allowed).toBe(false)
		expect(verifyDestinationUrl("not a url").allowed).toBe(false)
	})

	it("accepts an ordinary https endpoint", () => {
		const verdict = verifyDestinationUrl("https://hooks.example.com/services/abc")
		expect(verdict.allowed).toBe(true)
		expect(verdict.allowed === true && verdict.hostname).toBe("hooks.example.com")
	})

	it("accepts http only for an address the operator named, and only with http turned on", () => {
		const namedOnly = egressPolicy({
			allowHttp: false,
			allowedHosts: "",
			allowedAddresses: "192.168.1.10",
		})
		const withHttp = egressPolicy({
			allowHttp: true,
			allowedHosts: "",
			allowedAddresses: "192.168.1.10",
		})

		expect(verifyDestinationUrl("http://192.168.1.10:8080/message", PUBLIC_ONLY).allowed).toBe(
			false,
		)
		expect(verifyDestinationUrl("http://192.168.1.10:8080/message", namedOnly).allowed).toBe(false)
		expect(verifyDestinationUrl("http://192.168.1.10:8080/message", withHttp).allowed).toBe(true)
		expect(verifyDestinationUrl("https://192.168.1.10:8080/message", namedOnly).allowed).toBe(true)
	})

	it("never allows plain http to somewhere the operator did not name", () => {
		const withHttp = egressPolicy({ allowHttp: true, allowedHosts: "", allowedAddresses: "" })
		expect(verifyDestinationUrl("http://hooks.example.com/x", withHttp).allowed).toBe(false)
	})
})

describe("what an operator is shown about a failure", () => {
	it("keeps the path out of it", () => {
		expect(sanitisedTarget("https://hooks.example.com/services/T00/B00/XXXX")).toBe(
			"https://hooks.example.com/…",
		)
		expect(sanitisedTarget("https://hooks.example.com/")).toBe("https://hooks.example.com")
	})

	it("says so plainly when there is nothing to show", () => {
		expect(sanitisedTarget("nonsense")).toBe("an address that could not be read")
	})

	it("never names a range, a registry or a protocol the reader did not ask about", () => {
		const reasons = [
			"127.0.0.1",
			"10.0.0.1",
			"169.254.169.254",
			"224.0.0.1",
			"fe80::1",
			"nonsense",
		].flatMap((address) => {
			const verdict = verifyAddress(address)
			return verdict.allowed ? [] : [verdict.reason]
		})

		expect(reasons).toHaveLength(6)
		for (const reason of reasons) {
			expect(reason).not.toMatch(/RFC|CIDR|IANA|IPv6|loopback|unicast|CGNAT|SSRF|\/\d+/i)
			expect(reason.length).toBeLessThan(60)
		}
	})
})

describe("hosts the operator has named", () => {
	const allowing = (hosts: string) =>
		egressPolicy({
			allowHttp: false,
			allowedHosts: hosts,
			allowedAddresses: "",
		})

	it("lets a named host through even though its name can only mean this network", () => {
		expect(verifyDestinationUrl("https://push.internal/hook").allowed).toBe(false)
		expect(
			verifyDestinationUrl("https://push.internal/hook", allowing("push.internal")).allowed,
		).toBe(true)
		expect(
			verifyDestinationUrl("https://gotify.localhost/hook", allowing("gotify.localhost")).allowed,
		).toBe(true)
	})

	it("lets a named host through even though it is written as a private address", () => {
		expect(
			verifyDestinationUrl("https://192.168.1.10/hook", allowing("192.168.1.10")).allowed,
		).toBe(true)
	})

	it("does not extend to anything under a named host", () => {
		const policy = allowing("push.internal")

		expect(verifyDestinationUrl("https://push.internal/hook", policy).allowed).toBe(true)
		expect(verifyDestinationUrl("https://api.push.internal/hook", policy).allowed).toBe(false)
		expect(verifyDestinationUrl("https://push.internal.example/hook", policy).allowed).toBe(true)
		expect(hostIsAllowed("api.push.internal", policy)).toBe(false)
		expect(hostIsAllowed("push.internal.example", policy)).toBe(false)
		expect(hostIsAllowed("push.internal", policy)).toBe(true)
	})

	it("refuses a name that merely ends with a named host", () => {
		const policy = allowing("internal.example")

		expect(hostIsAllowed("not-internal.example", policy)).toBe(false)
		expect(hostIsAllowed("xinternal.example", policy)).toBe(false)
		expect(hostIsAllowed("internal.example", policy)).toBe(true)
	})

	it("does not name a port, so any port on a named host is reached the same way", () => {
		const policy = allowing("push.internal")

		expect(verifyDestinationUrl("https://push.internal:8443/hook", policy).allowed).toBe(true)
		expect(verifyDestinationUrl("https://push.internal/hook", policy).allowed).toBe(true)
	})

	it("reads the list case-insensitively and ignores blanks and spacing", () => {
		const policy = allowing("  PUSH.Example.COM , , gotify.lan  ")

		expect(hostIsAllowed("push.example.com", policy)).toBe(true)
		expect(hostIsAllowed("gotify.lan", policy)).toBe(true)
		expect(policy.allowedHosts).toEqual(["push.example.com", "gotify.lan"])
	})

	it("accepts a v6 host written with or without its brackets", () => {
		expect(hostIsAllowed("::1", allowing("[::1]"))).toBe(true)
		expect(hostIsAllowed("[::1]", allowing("::1"))).toBe(true)
	})

	it("still insists on https, and still refuses credentials and fragments", () => {
		const policy = allowing("push.example.com")

		expect(verifyDestinationUrl("http://push.example.com/hook", policy).allowed).toBe(false)
		expect(verifyDestinationUrl("https://u:p@push.example.com/hook", policy).allowed).toBe(false)
		expect(verifyDestinationUrl("https://push.example.com/hook#part", policy).allowed).toBe(false)
	})
})

describe("addresses the operator has named", () => {
	const allowing = (addresses: string) =>
		egressPolicy({
			allowHttp: false,
			allowedHosts: "",
			allowedAddresses: addresses,
		})

	it("lets a single named address through and nothing beside it", () => {
		const policy = allowing("10.1.2.3")

		expect(verifyAddress("10.1.2.3", policy).allowed).toBe(true)
		expect(verifyAddress("10.1.2.4", policy).allowed).toBe(false)
	})

	it("lets a named range through and stops at its edges", () => {
		const policy = allowing("192.168.4.0/24")

		expect(verifyAddress("192.168.4.0", policy).allowed).toBe(true)
		expect(verifyAddress("192.168.4.255", policy).allowed).toBe(true)
		expect(verifyAddress("192.168.3.255", policy).allowed).toBe(false)
		expect(verifyAddress("192.168.5.0", policy).allowed).toBe(false)
	})

	it("names a v6 address or range the same way", () => {
		expect(verifyAddress("fd00::5", allowing("fd00::5")).allowed).toBe(true)
		expect(verifyAddress("fd00::5", allowing("fd00::/8")).allowed).toBe(true)
		expect(verifyAddress("fd01::5", allowing("fd00::/16")).allowed).toBe(false)
	})

	it("covers the v6 spelling of a named v4 address", () => {
		expect(verifyAddress("::ffff:10.1.2.3", allowing("10.1.2.3")).allowed).toBe(true)
		expect(verifyAddress("::ffff:10.1.2.4", allowing("10.1.2.3")).allowed).toBe(false)
	})

	it("takes several entries at once", () => {
		const policy = allowing("127.0.0.1, 10.0.0.0/8")

		expect(verifyAddress("127.0.0.1", policy).allowed).toBe(true)
		expect(verifyAddress("10.9.9.9", policy).allowed).toBe(true)
		expect(verifyAddress("172.16.0.1", policy).allowed).toBe(false)
	})

	it("cannot open the metadata address, even named outright", () => {
		expect(verifyAddress("169.254.169.254", allowing("")).allowed).toBe(false)
		expect(verifyAddress("169.254.169.254", allowing("169.254.169.254")).allowed).toBe(false)
	})

	it("does not let a named address stand in for a name", () => {
		const policy = allowing("127.0.0.1")

		expect(verifyDestinationUrl("https://localhost/hook", policy).allowed).toBe(false)
	})

	it("refuses to start rather than quietly dropping an entry it cannot read", () => {
		expect(() => allowing("192.168.1.999")).toThrow()
		expect(() => allowing("10.0.0.0/64")).toThrow()
		expect(() => allowing("not-an-address")).toThrow()
	})

	it.each(["", "10.0.0.1", "10.0.0.0/8, ::1, fd00::/8", " 127.0.0.1 , "])(
		"reads %s as a usable list",
		(raw) => {
			expect(readsAsAddressList(raw)).toBe(true)
		},
	)

	it.each(["nonsense", "10.0.0.1, nonsense", "10.0.0.0/33", "fd00::/129"])(
		"reads %s as unusable",
		(raw) => {
			expect(readsAsAddressList(raw)).toBe(false)
		},
	)
})

describe("plain http is its own decision", () => {
	const withHttp = (addresses: string) =>
		egressPolicy({ allowHttp: true, allowedHosts: "", allowedAddresses: addresses })

	it("is off unless the operator turns it on", () => {
		expect(PUBLIC_ONLY.allowHttp).toBe(false)
		expect(
			egressPolicy({ allowHttp: false, allowedHosts: "", allowedAddresses: "" }).allowHttp,
		).toBe(false)
	})

	it("reaches only what was named, never merely what is private", () => {
		expect(verifyDestinationUrl("http://192.168.1.10/message", withHttp("")).allowed).toBe(false)
		expect(
			verifyDestinationUrl("http://192.168.1.10/message", withHttp("192.168.1.10")).allowed,
		).toBe(true)
		expect(
			verifyDestinationUrl("http://192.168.1.11/message", withHttp("192.168.1.10")).allowed,
		).toBe(false)
	})

	it("reaches a named host over http, and that host only", () => {
		const policy = egressPolicy({
			allowHttp: true,
			allowedHosts: "gotify.localhost",
			allowedAddresses: "",
		})

		expect(verifyDestinationUrl("http://gotify.localhost:8080/message", policy).allowed).toBe(true)
		expect(verifyDestinationUrl("http://ntfy.localhost:8080/message", policy).allowed).toBe(false)
	})

	it("does not turn https off for anyone", () => {
		expect(verifyDestinationUrl("https://hooks.example.com/x", withHttp("")).allowed).toBe(true)
	})

	it("still refuses credentials and fragments", () => {
		const policy = withHttp("10.0.0.1")
		expect(verifyDestinationUrl("http://u:p@10.0.0.1/hook", policy).allowed).toBe(false)
		expect(verifyDestinationUrl("http://10.0.0.1/hook#part", policy).allowed).toBe(false)
	})

	it("refuses a scheme that is neither", () => {
		expect(verifyDestinationUrl("ftp://hooks.example.com/x", withHttp("")).allowed).toBe(false)
		expect(verifyDestinationUrl("file:///etc/passwd", withHttp("")).allowed).toBe(false)
	})
})

describe("naming a host", () => {
	it("is a plain, case-insensitive, exact match", () => {
		const policy = egressPolicy({
			allowHttp: false,
			allowedHosts: "Gotify.Internal",
			allowedAddresses: "",
		})

		expect(hostIsAllowed("gotify.internal", policy)).toBe(true)
		expect(hostIsAllowed("GOTIFY.INTERNAL", policy)).toBe(true)
		expect(hostIsAllowed("api.gotify.internal", policy)).toBe(false)
		expect(hostIsAllowed("notgotify.internal", policy)).toBe(false)
	})

	it("reads a v6 host with or without its brackets", () => {
		const policy = egressPolicy({
			allowHttp: false,
			allowedHosts: "[fd00::1]",
			allowedAddresses: "",
		})

		expect(hostIsAllowed("fd00::1", policy)).toBe(true)
		expect(hostIsAllowed("[fd00::1]", policy)).toBe(true)
	})
})
