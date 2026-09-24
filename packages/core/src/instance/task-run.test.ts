import { describe, expect, it } from "vitest"
import { InstanceTaskStepsFailedError, sendStepsInOrder, type TaskStep } from "./task-run"

const STEPS: TaskStep[] = [
	{ position: 0, command: "/economy" },
	{ position: 1, command: "/local" },
	{ position: 2, command: "/visit .ArrayIndexInOfB" },
]

const runner = (fail?: (command: string) => boolean) => {
	const sent: string[] = []
	const waits: number[] = []
	return {
		sent,
		waits,
		runner: {
			send: async (command: string) => {
				if (fail?.(command) === true) throw new Error("the host refused the write")
				sent.push(command)
			},
			wait: async (milliseconds: number) => {
				waits.push(milliseconds)
			},
			describeFailure: (error: Error | string) => (error instanceof Error ? error.message : error),
		},
	}
}

describe("sending a task's steps", () => {
	it("sends them in position order, not the order they were handed over", async () => {
		const made = runner()
		const shuffled: TaskStep[] = [
			{ position: 2, command: "/visit .ArrayIndexInOfB" },
			{ position: 0, command: "/economy" },
			{ position: 1, command: "/local" },
		]
		const sent = await sendStepsInOrder(shuffled, 0, made.runner)
		expect(made.sent).toEqual(["/economy", "/local", "/visit .ArrayIndexInOfB"])
		expect(sent).toBe(3)
	})

	it("waits between steps and never before the first", async () => {
		const made = runner()
		await sendStepsInOrder(STEPS, 3, made.runner)
		expect(made.waits).toEqual([3000, 3000])
	})

	it("waits not at all when the delay is zero", async () => {
		const made = runner()
		await sendStepsInOrder(STEPS, 0, made.runner)
		expect(made.waits).toEqual([])
	})

	it("stops at the step that failed and never sends the ones behind it", async () => {
		const made = runner((command) => command === "/local")
		await expect(sendStepsInOrder(STEPS, 0, made.runner)).rejects.toBeInstanceOf(
			InstanceTaskStepsFailedError,
		)
		expect(made.sent).toEqual(["/economy"])
	})

	it("reports which step failed and how many had been sent", async () => {
		const made = runner((command) => command === "/local")
		const failure = await sendStepsInOrder(STEPS, 0, made.runner).catch((error) => error)
		expect(failure).toBeInstanceOf(InstanceTaskStepsFailedError)
		expect(failure instanceof InstanceTaskStepsFailedError ? failure.stepsSent : -1).toBe(1)
		expect(String(failure)).toContain("Step 2 of 3")
		expect(String(failure)).toContain("the rest were not sent")
	})

	it("blames the first step when it is the one that failed", async () => {
		const made = runner((command) => command === "/economy")
		const failure = await sendStepsInOrder(STEPS, 0, made.runner).catch((error) => error)
		expect(failure instanceof InstanceTaskStepsFailedError ? failure.stepsSent : -1).toBe(0)
		expect(String(failure)).toContain("Step 1 of 3")
		expect(made.sent).toEqual([])
	})
})
