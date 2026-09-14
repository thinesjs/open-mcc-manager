import { describe, expect, it } from "vitest"
import { instanceDir, renderEnvironmentFile, unitName, validateInstanceId } from "./unit"

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

describe("environment file rendering", () => {
	it("refuses a newline, which would define a second variable", () => {
		expect(() => renderEnvironmentFile({ liveControlToken: "a\nMCC_EVIL=1" })).toThrow(/newline/i)
	})

	it("quotes and escapes the token", () => {
		expect(renderEnvironmentFile({ liveControlToken: 'tok"x' })).toContain(
			'MCC_MCP_AUTH_TOKEN="tok\\"x"',
		)
	})

	it("carries the token under the name the client reads it from", () => {
		expect(renderEnvironmentFile({ liveControlToken: "abc123" })).toBe(
			'MCC_MCP_AUTH_TOKEN="abc123"\n',
		)
	})

	it("never writes the account or server, which the client ignores anyway", () => {
		const rendered = renderEnvironmentFile({ liveControlToken: "abc123" })

		expect(rendered).not.toContain("MCC_SERVER")
		expect(rendered).not.toContain("MCC_ACCOUNT")
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
