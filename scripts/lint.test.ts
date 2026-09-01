import type { SpawnSyncReturns } from "node:child_process"
import { describe, expect, it } from "vitest"
import { runAll } from "./lint.mjs"

const CHECKS = [
	{ name: "first", command: "first-cmd", args: [] },
	{ name: "second", command: "second-cmd", args: [] },
]

const spawned = (stdout: string, status: number): SpawnSyncReturns<string> => ({
	pid: 1,
	output: [null, stdout, ""],
	stdout,
	stderr: "",
	status,
	signal: null,
})

describe("lint runner", () => {
	it("runs every check even when an earlier one fails, so no failure can mask another", () => {
		const ran: string[] = []
		const results = runAll(CHECKS, (command: string) => {
			ran.push(command)
			return spawned(`${command} output`, command === "first-cmd" ? 1 : 0)
		})

		expect(ran).toEqual(["first-cmd", "second-cmd"])
		expect(results.map((each) => each.ok)).toEqual([false, true])
	})

	it("reports the output of a later check that an earlier failure would have hidden", () => {
		const results = runAll(CHECKS, (command: string) =>
			spawned(command === "second-cmd" ? "forbidden token 'never'" : "formatting nit", 1),
		)

		expect(results.map((each) => each.output)).toEqual([
			"formatting nit",
			"forbidden token 'never'",
		])
		expect(results.every((each) => each.ok)).toBe(false)
	})

	it("surfaces a check that could not be spawned rather than counting it as a pass", () => {
		const results = runAll([{ name: "missing", command: "nope", args: [] }], () => ({
			...spawned("", 0),
			status: null,
			error: new Error("ENOENT"),
		}))

		expect(results.map((each) => each.ok)).toEqual([false])
		expect(results.map((each) => each.output.includes("ENOENT"))).toEqual([true])
	})
})
