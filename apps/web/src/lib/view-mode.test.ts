import { describe, expect, it } from "vitest"
import {
	DEFAULT_VIEW_MODE,
	isViewMode,
	readViewMode,
	type ViewStorage,
	writeViewMode,
} from "./view-mode"

const fakeStorage = (initial: Record<string, string> = {}): ViewStorage => {
	const values = new Map(Object.entries(initial))
	return {
		getItem: (key) => values.get(key) ?? null,
		setItem: (key, value) => {
			values.set(key, value)
		},
	}
}

describe("remembering how someone prefers to see a list", () => {
	it("shows cards until told otherwise", () => {
		expect(DEFAULT_VIEW_MODE).toBe("cards")
		expect(readViewMode("hosts", fakeStorage())).toBe("cards")
	})

	it("remembers a choice for that list alone", () => {
		const storage = fakeStorage()

		writeViewMode("hosts", "list", storage)

		expect(readViewMode("hosts", storage)).toBe("list")
		expect(readViewMode("instances", storage)).toBe("cards")
	})

	it("ignores a stored value that is not a view, rather than rendering nothing", () => {
		expect(readViewMode("hosts", fakeStorage({ hosts: "carousel" }))).toBe("cards")
	})

	it("falls back to cards when storage is unavailable, as in a private window", () => {
		const blocked: ViewStorage = {
			getItem: () => {
				throw new Error("blocked")
			},
			setItem: () => {
				throw new Error("blocked")
			},
		}

		expect(readViewMode("hosts", blocked)).toBe("cards")
		expect(() => writeViewMode("hosts", "list", blocked)).not.toThrow()
	})

	it("works on a server render, where there is no window at all", () => {
		expect(readViewMode("hosts", undefined)).toBe("cards")
		expect(() => writeViewMode("hosts", "list", undefined)).not.toThrow()
	})

	it("accepts only the views that exist", () => {
		expect(isViewMode("cards")).toBe(true)
		expect(isViewMode("table")).toBe(false)
	})
})
