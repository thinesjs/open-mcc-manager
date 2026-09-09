import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const here = dirname(fileURLToPath(import.meta.url))
const form = readFileSync(join(here, "instance-settings-form.tsx"), "utf8")
const detail = readFileSync(
	join(here, "..", "routes", "_authenticated.instances.$instanceId.tsx"),
	"utf8",
)

const DELAY_FIELDS = ["autoRelogDelaySeconds", "antiAfkIntervalSeconds"] as const

describe("editing a delay range", () => {
	it.each(DELAY_FIELDS)(
		"gives %s its own two-bound field, so the two cannot cross-wire",
		(field) => {
			expect(form).toContain(`value={draft.${field}}`)
			expect(form).toContain(`onChange={(${field}) => setDraft({ ...draft, ${field} })}`)
		},
	)

	it("labels which bound is which rather than leaving two bare boxes", () => {
		expect(form).toContain("Shortest")
		expect(form).toContain("Longest")
	})

	it("never hands a whole range to the numeric parser that expects one number", () => {
		for (const field of DELAY_FIELDS) {
			expect(form).not.toContain(`boundedInt(event.target.value, draft.${field})`)
		}
	})
})

describe("switching auto-relog off", () => {
	it("drives the toggle from the operator's value, not a hardcoded one", () => {
		expect(form).toContain('value={draft.autoRelogEnabled ? "on" : "off"}')
		expect(form).toContain(
			'onChange={(value) => setDraft({ ...draft, autoRelogEnabled: value === "on" })}',
		)
	})

	it("hides the attempts and the wait when there will be no rejoining", () => {
		expect(form).toContain("{draft.autoRelogEnabled ? (")
	})
})

describe("the saved-settings summary", () => {
	it.each(DELAY_FIELDS)("shows %s through the range formatter", (field) => {
		expect(detail).toContain(`formatDelaySeconds(configQuery.data.${field})`)
	})

	it.each(DELAY_FIELDS)("never interpolates %s straight into the summary text", (field) => {
		expect(detail).not.toContain(`\${configQuery.data.${field}}`)
	})

	it("tells an operator whether rejoining is on at all", () => {
		expect(detail).toContain('{configQuery.data.autoRelogEnabled ? "On" : "Off"}')
	})
})
