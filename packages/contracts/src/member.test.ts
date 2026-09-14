import { describe, expect, it } from "vitest"
import { pendingInvitationSchema } from "./member"

const invitation = {
	id: "inv-1",
	email: "new@example.com",
	role: "viewer",
}

describe("when a pending invitation expires, as the wire sends it", () => {
	it("requires the ISO string a JSON response carries, not a Date object", () => {
		expect(
			pendingInvitationSchema.safeParse({ ...invitation, expiresAt: new Date() }).success,
		).toBe(false)
		expect(
			pendingInvitationSchema.safeParse({
				...invitation,
				expiresAt: "2026-09-20T00:00:00.000Z",
			}).success,
		).toBe(true)
	})
})
