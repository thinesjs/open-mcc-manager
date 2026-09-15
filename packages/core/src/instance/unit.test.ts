import { randomUUID } from "node:crypto"
import { describe, expect, it } from "vitest"
import {
	INSTANCE_LAYOUT,
	instanceDir,
	renderEnvironmentFile,
	renderUnitEnv,
	unitName,
	validateInstanceId,
} from "./unit"

const TOKEN = "0123456789abcdef0123456789abcdef"

describe("instance id validation", () => {
	it("rejects a systemd specifier, naming that as the reason", () => {
		expect(() => validateInstanceId("a%i")).toThrow(/systemd/i)
	})

	it("rejects a path separator and whitespace", () => {
		expect(() => validateInstanceId("a/b")).toThrow()
		expect(() => validateInstanceId("a b")).toThrow()
		expect(() => validateInstanceId("")).toThrow()
	})

	it("accepts an ordinary generated id", () => {
		expect(validateInstanceId("V1StGXR8Z5jdHi6B")).toBe("V1StGXR8Z5jdHi6B")
	})
})

describe("what a bot's directory holds", () => {
	it("names each file and directory the units and the manager use", () => {
		expect(INSTANCE_LAYOUT).toEqual({
			config: "config",
			state: "state",
			replays: "replays",
			recordingCache: "recording-cache",
			unitEnv: "unit.env",
			env: "env",
			control: "control",
			collectLock: "collect.lock",
		})
	})
})

describe("the token file", () => {
	it("carries the token unquoted, since Podman keeps quotes as part of the value", () => {
		expect(renderEnvironmentFile({ liveControlToken: TOKEN })).toBe(`MCC_MCP_AUTH_TOKEN=${TOKEN}\n`)
	})

	it("accepts the token the controller mints", () => {
		const minted = randomUUID().replaceAll("-", "")

		expect(renderEnvironmentFile({ liveControlToken: minted })).toBe(
			`MCC_MCP_AUTH_TOKEN=${minted}\n`,
		)
	})

	it.each([
		["uppercase hex", TOKEN.toUpperCase()],
		["31 characters", TOKEN.slice(1)],
		["33 characters", `${TOKEN}0`],
		["a newline", `${TOKEN.slice(1)}\n`],
		["an equals sign", `${TOKEN.slice(1)}=`],
		["a double quote", `"${TOKEN.slice(2)}"`],
		["a single quote", `'${TOKEN.slice(2)}'`],
		["nothing", ""],
	])("refuses a token carrying %s", (_case, liveControlToken) => {
		expect(() => renderEnvironmentFile({ liveControlToken })).toThrow(/token/i)
	})

	it("never writes the account or server, which the client ignores anyway", () => {
		const rendered = renderEnvironmentFile({ liveControlToken: TOKEN })

		expect(rendered).not.toContain("MCC_SERVER")
		expect(rendered).not.toContain("MCC_ACCOUNT")
	})
})

describe("the unit's own environment file", () => {
	it("carries the live control port and nothing else", () => {
		expect(renderUnitEnv(33333)).toBe("OPEN_MCC_PORT=33333\n")
	})

	it("accepts both ends of the port range", () => {
		expect(renderUnitEnv(1)).toBe("OPEN_MCC_PORT=1\n")
		expect(renderUnitEnv(65535)).toBe("OPEN_MCC_PORT=65535\n")
	})

	it.each([
		["0", 0],
		["65536", 65536],
		["a negative number", -1],
		["a fraction", 33333.5],
		["not a number", Number.NaN],
		["infinity", Number.POSITIVE_INFINITY],
		["a number that prints with an exponent", 1e21],
	])("refuses %s, which is no port", (_case, port) => {
		expect(() => renderUnitEnv(port)).toThrow(/port/i)
	})
})

describe("names built from an instance id validate it by construction", () => {
	it("refuses to build a unit name for an id carrying a systemd specifier", () => {
		expect(() => unitName("a%i")).toThrow(/systemd/i)
	})

	it("refuses to build a directory path for an id carrying a path separator", () => {
		expect(() => instanceDir("../../etc")).toThrow()
	})

	it("builds both for an ordinary id", () => {
		expect(unitName("V1StGXR8Z5jdHi6B")).toBe("open-mcc@V1StGXR8Z5jdHi6B")
		expect(instanceDir("V1StGXR8Z5jdHi6B")).toBe(
			'"$HOME"/.local/share/open-mcc/instances/V1StGXR8Z5jdHi6B',
		)
	})
})
