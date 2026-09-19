import { describe, expect, it, vi } from "vitest"
import { createEscalationHandler, readEscalationPayload } from "./escalation.job"

const payload = { organizationId: "org_1", instanceId: "inst_1", incidentId: "inc_1" }

describe("reading an escalation job", () => {
	it("accepts a whole payload", () => {
		expect(readEscalationPayload(payload)).toEqual(payload)
	})

	it("refuses one missing a piece, rather than escalating the wrong bot", () => {
		for (const bad of [
			{},
			{ organizationId: "org_1", instanceId: "inst_1" },
			{ ...payload, incidentId: "" },
			{ ...payload, instanceId: 7 },
			{ ...payload, organizationId: null },
		]) {
			expect(readEscalationPayload(bad)).toBeUndefined()
		}
	})
})

describe("running an escalation", () => {
	it("passes the incident through so the controller can check it is still the same one", async () => {
		const escalate = vi.fn(async () => true)
		const handle = createEscalationHandler({ escalate })

		expect(await handle(payload)).toBe(true)
		expect(escalate).toHaveBeenCalledWith({ organizationId: "org_1" }, "inst_1", "inc_1")
	})

	it("does nothing at all with a payload it cannot read", async () => {
		const escalate = vi.fn(async () => true)
		const handle = createEscalationHandler({ escalate })

		expect(await handle({ instanceId: "inst_1" })).toBe(false)
		expect(escalate).not.toHaveBeenCalled()
	})

	it("reports quietly when the controller declines, which is the normal case after a rejoin", async () => {
		const handle = createEscalationHandler({ escalate: async () => false })
		expect(await handle(payload)).toBe(false)
	})
})
