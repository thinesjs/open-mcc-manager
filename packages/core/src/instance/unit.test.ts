import { describe, expect, it } from "vitest"
import { renderEnvironmentFile, validateInstanceId } from "./unit"

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
		expect(() =>
			renderEnvironmentFile({ serverAddress: "a\nMCC_EVIL=1", minecraftAccount: "a@b.com" }),
		).toThrow(/newline/i)
	})

	it("quotes and escapes both values", () => {
		const rendered = renderEnvironmentFile({
			serverAddress: 'play"x',
			minecraftAccount: "afk@example.com",
		})
		expect(rendered).toContain('MCC_SERVER="play\\"x"')
		expect(rendered).toContain('MCC_ACCOUNT="afk@example.com"')
	})
})
