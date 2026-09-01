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

describe("names built from an instance id validate it by construction", () => {
	it("refuses to build a unit name for an id carrying a systemd specifier", () => {
		expect(() => unitName("a%i")).toThrow(/systemd/i)
	})

	it("refuses to build a directory path for an id carrying a path separator", () => {
		expect(() => instanceDir("/srv/open-mcc", "../../etc")).toThrow()
	})

	it("builds both for an ordinary id", () => {
		expect(unitName("V1StGXR8Z5jdHi6B")).toBe("open-mcc@V1StGXR8Z5jdHi6B")
		expect(instanceDir("/srv/open-mcc", "V1StGXR8Z5jdHi6B")).toBe(
			"/srv/open-mcc/instances/V1StGXR8Z5jdHi6B",
		)
	})
})
