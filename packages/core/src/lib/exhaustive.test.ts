import { describe, expect, it } from "vitest"
import { assertExhaustive } from "./exhaustive"

type Signal = "start" | "stop"

const describeSignal = (signal: Signal): string => {
	if (signal === "start") return "starting"
	if (signal === "stop") return "stopping"
	return assertExhaustive(signal)
}

describe("assertExhaustive", () => {
	it("stays out of the way while every case of the union is handled", () => {
		expect(describeSignal("start")).toBe("starting")
		expect(describeSignal("stop")).toBe("stopping")
	})

	it("throws naming the value when one arrives from outside the type system", () => {
		const decodedFromStorage: Signal[] = JSON.parse('["restart"]')
		const escaped = decodedFromStorage[0]
		if (!escaped) throw new Error("test setup: expected one decoded signal")

		expect(() => describeSignal(escaped)).toThrow(/restart/)
	})
})
