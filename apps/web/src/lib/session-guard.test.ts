import { describe, expect, it } from "vitest"
import { decideFromSession } from "./session-guard"

describe("deciding whether a visitor may stay", () => {
	it("lets a signed-in visitor through", () => {
		expect(decideFromSession({ data: { session: { id: "s1" } } })).toBe("allow")
	})

	it("sends a signed-out visitor to sign in", () => {
		expect(decideFromSession({ data: null })).toBe("redirect")
		expect(decideFromSession({ data: { session: null } })).toBe("redirect")
	})

	it("does not sign a visitor out because the check was rate limited", () => {
		expect(decideFromSession({ error: { status: 429 } })).toBe("allow")
	})

	it("does not sign a visitor out because the check failed for any other reason", () => {
		expect(decideFromSession({ error: { status: 500 } })).toBe("allow")
		expect(decideFromSession({ error: {} })).toBe("allow")
	})

	it("never depends on an active organization, which a fresh session may not carry yet", () => {
		expect(decideFromSession({ data: { session: { id: "s1" } } })).toBe("allow")
	})
})
