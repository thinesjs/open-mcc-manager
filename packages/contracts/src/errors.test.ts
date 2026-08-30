import { describe, expect, it } from "vitest"
import { ERROR_CODES, errorCodeSchema, isErrorCode } from "./errors"

describe("errorCodeSchema", () => {
	it("accepts every code the wire contract declares", () => {
		for (const code of ERROR_CODES) {
			expect(errorCodeSchema.parse(code)).toBe(code)
		}
	})

	it("rejects a code no layer agreed on", () => {
		expect(() => errorCodeSchema.parse("HOST_ON_FIRE")).toThrow()
	})
})

describe("isErrorCode", () => {
	it("narrows a code the server can send", () => {
		expect(isErrorCode("FINGERPRINT_MISMATCH")).toBe(true)
	})

	it("refuses an unrecognised code arriving off the wire", () => {
		expect(isErrorCode("BAD_REQUEST")).toBe(false)
	})

	it("refuses a response that carries no code at all", () => {
		expect(isErrorCode(undefined)).toBe(false)
	})
})
