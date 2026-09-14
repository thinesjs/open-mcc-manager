import { describe, expect, it } from "vitest"
import { describeLiveEvent } from "./live-events"

describe("describing a live event", () => {
	it("puts the player before what they did", () => {
		expect(
			describeLiveEvent({ id: 1, timestampUtc: "t", type: "player_join", subject: "Steve" }),
		).toBe("Steve joined")
	})

	it("reads a weather level as a change to that level, not as a subject", () => {
		expect(
			describeLiveEvent({ id: 1, timestampUtc: "t", type: "weather_thunder", subject: "0.01" }),
		).toBe("thunder changed to 0.01")
	})

	it.each([
		{ sent: "0.30000001", shown: "rain changed to 0.3" },
		{ sent: "0.14000066", shown: "rain changed to 0.14" },
		{ sent: "6.7055225e-7", shown: "rain changed to 0" },
	])("rounds the float noise out of $sent", ({ sent, shown }) => {
		expect(
			describeLiveEvent({ id: 1, timestampUtc: "t", type: "weather_rain", subject: sent }),
		).toBe(shown)
	})

	it("says what happened when there is nobody it happened to", () => {
		expect(describeLiveEvent({ id: 1, timestampUtc: "t", type: "death" })).toBe("died")
	})

	it("renders an event type it has never seen rather than hiding it", () => {
		expect(describeLiveEvent({ id: 1, timestampUtc: "t", type: "some_new_thing" })).toBe(
			"some new thing",
		)
	})
})
