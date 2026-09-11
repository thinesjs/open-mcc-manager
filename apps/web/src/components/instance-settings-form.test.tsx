import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { instanceConfigInput, updateInstanceConfigInput } from "@open-mcc/contracts"
import type { AdvancedKeys } from "@open-mcc/contracts/boundary/mcc-config-keys"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { InstanceSettingsForm } from "./instance-settings-form"

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

const CONFIG = instanceConfigInput.parse({
	accountType: "offline",
	minecraftAccount: "OpenMccBot",
	serverAddress: "play.example.com:25565",
	autoRelogRetries: 3,
	autoRelogEnabled: true,
	autoRelogDelaySeconds: { min: 5, max: 20 },
	antiAfkEnabled: true,
	antiAfkIntervalSeconds: { min: 90, max: 300 },
})

const mutate = vi.fn()

vi.mock("~/lib/trpc", () => ({
	useTRPC: () => ({
		instance: { updateConfig: { mutationOptions: () => ({ mutationFn: mutate }) } },
	}),
}))

const mount = (advancedKeys: AdvancedKeys) => {
	const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
	return render(
		<QueryClientProvider client={client}>
			<InstanceSettingsForm
				instanceId="i1"
				config={{ ...CONFIG, advancedKeys }}
				onSaved={async () => undefined}
				onCancel={() => undefined}
			/>
		</QueryClientProvider>,
	)
}

const save = async () => {
	screen.getByText("Save settings").click()
	await act(async () => undefined)
}

const sentConfig = () => mutate.mock.calls[0]?.[0]?.config

const advancedRowOf = (label: string) =>
	screen.getAllByRole("combobox").find((trigger) => trigger.textContent === label)

afterEach(() => {
	cleanup()
	mutate.mockReset()
})

describe("saving the advanced keys an operator has set", () => {
	it("forwards a valid key with the rest of the config", async () => {
		mount({ "ChatBot.AutoEat.Enabled": "true" })

		await save()

		expect(mutate).toHaveBeenCalledTimes(1)
		expect(sentConfig()?.advancedKeys).toEqual({ "ChatBot.AutoEat.Enabled": "true" })
	})

	it("sends a config the server's own contract accepts", async () => {
		mount({ "ChatBot.AutoEat.Enabled": "true" })

		await save()

		expect(updateInstanceConfigInput.safeParse(mutate.mock.calls[0]?.[0]).success).toBe(true)
	})

	it("renders a stored key as a row the operator can see", () => {
		mount({ "ChatBot.AutoEat.Threshold": "5" })

		expect(advancedRowOf("ChatBot.AutoEat.Threshold")).toBeDefined()
	})

	it("does not save at all while a value is invalid, and says why", async () => {
		mount({ "ChatBot.ItemsCollector.Collection_Radius": "" })

		await save()

		expect(mutate).not.toHaveBeenCalled()
		expect(screen.getByText("Decimal number")).toBeDefined()
	})

	it("disables the save control rather than letting it look available", () => {
		mount({ "ChatBot.ItemsCollector.Collection_Radius": "" })

		expect(screen.getByText("Save settings").closest("button")).toHaveProperty("disabled", true)
	})

	it("loses nothing when the operator adds a row and never chooses a key", async () => {
		mount({})
		fireEvent.click(screen.getByText("Add a key"))
		fireEvent.change(screen.getByLabelText("Value"), { target: { value: "1.5" } })

		await save()

		expect(mutate).not.toHaveBeenCalled()
		expect(screen.queryAllByText("Choose a key").length).toBeGreaterThan(0)
	})

	it("saves an empty object for an instance that has set none", async () => {
		mount({})

		await save()

		expect(sentConfig()?.advancedKeys).toEqual({})
	})

	it("drops a key the operator removed", async () => {
		mount({ "ChatBot.AutoEat.Enabled": "true", "ChatBot.AutoFishing.Auto_Start": "false" })
		const removes = screen.getAllByText("Remove")
		await act(async () => {
			removes[1]?.click()
		})

		expect(screen.getAllByText("Remove")).toHaveLength(1)
		await save()

		expect(sentConfig()?.advancedKeys).toEqual({ "ChatBot.AutoEat.Enabled": "true" })
	})

	it("carries a value the operator edited rather than the one it was given", async () => {
		mount({ "ChatBot.AutoEat.Threshold": "5" })
		fireEvent.change(screen.getByLabelText("Value"), { target: { value: "9" } })

		await save()

		expect(sentConfig()?.advancedKeys).toEqual({ "ChatBot.AutoEat.Threshold": "9" })
	})
})

describe("the submission itself, not merely the button that starts it", () => {
	it("refuses an unselected row even when the submit arrives without the button", async () => {
		const { container } = mount({})
		fireEvent.click(screen.getByText("Add a key"))
		const form = container.querySelector("form")
		if (form === null) throw new Error("expected the settings form to render")

		await act(async () => {
			fireEvent.submit(form)
		})

		expect(mutate).not.toHaveBeenCalled()
	})

	it("never reaches the mutation with an invalid value, by whichever guard catches it first", async () => {
		const { container } = mount({ "ChatBot.ItemsCollector.Collection_Radius": "" })
		const form = container.querySelector("form")
		if (form === null) throw new Error("expected the settings form to render")

		await act(async () => {
			fireEvent.submit(form)
		})

		expect(mutate).not.toHaveBeenCalled()
	})

	it("still saves a valid draft through that same path", async () => {
		const { container } = mount({ "ChatBot.AutoEat.Enabled": "true" })
		const form = container.querySelector("form")
		if (form === null) throw new Error("expected the settings form to render")

		await act(async () => {
			fireEvent.submit(form)
		})

		expect(mutate).toHaveBeenCalledTimes(1)
	})
})
