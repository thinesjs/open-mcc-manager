import { describe, expect, it } from "vitest"
import {
	isThemePreference,
	nextPreference,
	readStoredPreference,
	resolveTheme,
	storePreference,
	THEME_STORAGE_KEY,
} from "./theme"

describe("resolving which theme to paint", () => {
	it("follows the operating system when the operator has not chosen", () => {
		expect(resolveTheme("system", true)).toBe("dark")
		expect(resolveTheme("system", false)).toBe("light")
	})

	it("honours an explicit choice over the operating system", () => {
		expect(resolveTheme("light", true)).toBe("light")
		expect(resolveTheme("dark", false)).toBe("dark")
	})
})

describe("remembering the choice", () => {
	it("reads back what was stored", () => {
		const storage = new Map<string, string>([[THEME_STORAGE_KEY, "dark"]])
		expect(readStoredPreference({ getItem: (key) => storage.get(key) ?? null })).toBe("dark")
	})

	it("falls back to following the system when nothing is stored", () => {
		expect(readStoredPreference({ getItem: () => null })).toBe("system")
	})

	it("ignores a stored value that is not a theme", () => {
		expect(readStoredPreference({ getItem: () => "neon" })).toBe("system")
	})

	it("survives storage being unavailable, as it is in a private window", () => {
		expect(
			readStoredPreference({
				getItem: () => {
					throw new Error("blocked")
				},
			}),
		).toBe("system")
		expect(() =>
			storePreference(
				{
					setItem: () => {
						throw new Error("blocked")
					},
				},
				"dark",
			),
		).not.toThrow()
	})
})

describe("cycling the control", () => {
	it("moves through every option and returns to the start", () => {
		expect(nextPreference("system")).toBe("light")
		expect(nextPreference("light")).toBe("dark")
		expect(nextPreference("dark")).toBe("system")
	})
})

describe("validating a stored value", () => {
	it("accepts only the three preferences", () => {
		expect(isThemePreference("system")).toBe(true)
		expect(isThemePreference("dark")).toBe(true)
		expect(isThemePreference(null)).toBe(false)
		expect(isThemePreference("DARK")).toBe(false)
	})
})
