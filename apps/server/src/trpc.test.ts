import { TRPCError } from "@trpc/server"
import { describe, expect, it } from "vitest"
import { requireCapability } from "./trpc"

describe("requireCapability", () => {
	it("passes a permitted role through", () => {
		expect(() => requireCapability("owner", "host.enroll")).not.toThrow()
	})

	it("throws FORBIDDEN for a role without the capability", () => {
		try {
			requireCapability("viewer", "host.enroll")
			throw new Error("should have thrown")
		} catch (error) {
			expect(error).toBeInstanceOf(TRPCError)
			if (error instanceof TRPCError) expect(error.code).toBe("FORBIDDEN")
		}
	})
})
