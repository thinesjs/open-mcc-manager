import { describe, expect, it } from "vitest"
import {
	groupPaletteItems,
	initialsOf,
	rankPaletteItems,
	subsequenceScore,
} from "./command-palette"

const item = (id: string, label: string, group = "Go to", keywords?: string) =>
	keywords === undefined ? { id, label, group } : { id, label, group, keywords }

describe("subsequenceScore", () => {
	it("ranks a prefix above a mid-string hit", () => {
		expect(subsequenceScore("Instances", "ins")).toBeGreaterThan(
			subsequenceScore("My Instances", "ins"),
		)
	})

	it("matches letters spread through the label", () => {
		expect(subsequenceScore("live-control-1", "lc1")).toBeGreaterThan(0)
	})

	it("refuses a needle whose letters are out of order", () => {
		expect(subsequenceScore("abc", "cb")).toBe(-1)
	})

	it("scores an empty query as neutral rather than a miss", () => {
		expect(subsequenceScore("anything", "")).toBe(0)
	})
})

describe("initialsOf", () => {
	it("takes the first letter of each hyphen or space separated word", () => {
		expect(initialsOf("live-control-1")).toBe("lc1")
		expect(initialsOf("SSH keys")).toBe("sk")
	})
})

describe("rankPaletteItems", () => {
	it("returns everything, in order, for an empty query", () => {
		const items = [item("a", "Hosts"), item("b", "Instances")]

		expect(rankPaletteItems(items, "  ")).toEqual(items)
	})

	it("drops items that do not match at all", () => {
		const items = [item("a", "Hosts"), item("b", "Instances")]

		expect(rankPaletteItems(items, "zzz")).toEqual([])
	})

	it("puts the closest match first", () => {
		const items = [item("a", "Restart instance"), item("b", "Instances")]

		expect(rankPaletteItems(items, "inst")[0]?.id).toBe("b")
	})

	it("prefers a name whose initials match over a loose subsequence", () => {
		const items = [item("a", "legacy-1192", "Instances"), item("b", "live-control-1", "Instances")]

		expect(rankPaletteItems(items, "lc1")[0]?.id).toBe("b")
	})

	it("matches on keywords when the label does not contain the query", () => {
		const items = [item("a", "Sign out", "Account", "logout leave session")]

		expect(rankPaletteItems(items, "logout")).toHaveLength(1)
	})
})

describe("groupPaletteItems", () => {
	it("keeps groups in the order they first appear", () => {
		const grouped = groupPaletteItems([
			item("a", "Overview", "Go to"),
			item("b", "Restart", "Instance"),
			item("c", "Hosts", "Go to"),
		])

		expect(grouped.map((entry) => entry.group)).toEqual(["Go to", "Instance"])
		expect(grouped[0]?.items.map((entry) => entry.id)).toEqual(["a", "c"])
	})
})
