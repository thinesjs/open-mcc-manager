import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const here = dirname(fileURLToPath(import.meta.url))
const form = readFileSync(join(here, "alert-destination-form.tsx"), "utf8")

const KEPT_ACROSS_A_KIND_SWITCH = ["setName", "setKind", "setChosen"]

const setters = (): string[] =>
	Array.from(form.matchAll(/const \[[A-Za-z]+, (set[A-Za-z]+)\] = useState/g))
		.map((match) => match[1])
		.filter((setter): setter is string => setter !== undefined)

const chooseKindBody = (): string => {
	const start = form.indexOf("const chooseKind = ")
	expect(start, "chooseKind is missing").toBeGreaterThan(-1)
	const end = form.indexOf("\n\t}", start)
	return form.slice(start, end)
}

describe("switching which kind of destination you are adding", () => {
	it("routes the chooser through the reset, not straight at the state setter", () => {
		expect(form).toContain("onChange={chooseKind}")
		expect(form).not.toContain("onChange={setKind}")
	})

	it("clears every field that belongs to a kind, so no value rides along", () => {
		const body = chooseKindBody()
		const mustClear = setters().filter((setter) => !KEPT_ACROSS_A_KIND_SWITCH.includes(setter))

		expect(mustClear.length).toBeGreaterThan(10)
		for (const setter of mustClear) {
			expect(body, `${setter} is not cleared when the kind changes`).toContain(`${setter}(`)
		}
	})

	it("keeps the name and the chosen alerts, which are not tied to a kind", () => {
		const body = chooseKindBody()
		for (const setter of KEPT_ACROSS_A_KIND_SWITCH) {
			if (setter === "setKind") continue
			expect(body, `${setter} should survive a kind change`).not.toContain(`${setter}(`)
		}
	})
})
