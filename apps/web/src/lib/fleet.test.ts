import { describe, expect, it } from "vitest"
import { countByStatus, INSTANCE_STATUS_ORDER, instancesNeedingAttention } from "./fleet"

const instance = (name: string, status: "running" | "error" | "needs_auth" | "stopped") => ({
	id: name,
	name,
	status,
})

describe("fleet summary", () => {
	it("counts every status in the order the dashboard renders, including zeroes", () => {
		const counts = countByStatus(INSTANCE_STATUS_ORDER, [
			instance("a", "running"),
			instance("b", "running"),
			instance("c", "error"),
		])

		expect(counts).toEqual([
			{ status: "running", count: 2 },
			{ status: "stopped", count: 0 },
			{ status: "needs_auth", count: 0 },
			{ status: "error", count: 1 },
			{ status: "created", count: 0 },
		])
	})

	it("surfaces errored instances above ones merely waiting on a sign-in", () => {
		const attention = instancesNeedingAttention([
			instance("waiting", "needs_auth"),
			instance("broken", "error"),
		])

		expect(attention.map((each) => each.name)).toEqual(["broken", "waiting"])
	})

	it("leaves healthy instances out of the attention list entirely", () => {
		const attention = instancesNeedingAttention([
			instance("fine", "running"),
			instance("idle", "stopped"),
		])

		expect(attention).toEqual([])
	})
})
