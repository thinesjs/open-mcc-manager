import { describe, expect, it } from "vitest"
import { initialsFrom } from "./player-avatar"

describe("standing in for a player with no skin to show", () => {
	it("uses the first two characters of the name it was given", () => {
		expect(initialsFrom("survival-1")).toBe("SU")
	})

	it("copes with a name shorter than two characters", () => {
		expect(initialsFrom("a")).toBe("A")
	})

	it("shows a placeholder rather than nothing when there is no name at all", () => {
		expect(initialsFrom("")).toBe("?")
		expect(initialsFrom("   ")).toBe("?")
	})
})
