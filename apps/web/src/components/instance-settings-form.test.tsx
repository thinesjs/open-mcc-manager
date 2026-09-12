import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import type { InstanceConfigInput } from "@open-mcc/contracts"
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
	const DELAY_ROWS = [
		{
			field: "autoRelogDelaySeconds",
			id: "settings-delay",
			other: "antiAfkIntervalSeconds",
			untouched: { min: 90, max: 300 },
		},
		{
			field: "antiAfkIntervalSeconds",
			id: "settings-afk",
			other: "autoRelogDelaySeconds",
			untouched: { min: 5, max: 20 },
		},
	] as const

	it.each(DELAY_ROWS)(
		"★ edits only $field, leaving $other alone, so the two cannot cross-wire",
		async ({ field, id, other, untouched }) => {
			const { container } = mount({})
			const shortest = container.querySelector(`#${id}-min`)
			if (shortest === null) throw new Error(`expected a shortest bound for ${id}`)

			fireEvent.change(shortest, { target: { value: "42" } })
			await save()

			expect(sentConfig()?.[field]?.min).toBe(42)
			expect(sentConfig()?.[other]).toEqual(untouched)
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

describe("where the operator edits these settings", () => {
	it("★ puts the form on the page itself, so it has room to grow and works on a phone", () => {
		expect(detail).toContain("<InstanceSettingsForm")
		expect(detail).not.toContain("<Modal")
	})

	it("keeps no second read-only copy of the same values to drift out of step", () => {
		expect(detail).not.toContain("formatDelaySeconds(configQuery.data.")
	})

	it("gives the bots their own page too, rather than burying them in the same form", () => {
		expect(detail).toContain("<BotConfigPanel")
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
			/>
		</QueryClientProvider>,
	)
}

const remount = (
	rerender: (element: React.ReactElement) => void,
	instanceId: string,
	config: InstanceConfigInput,
) => {
	const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
	rerender(
		<QueryClientProvider client={client}>
			<InstanceSettingsForm
				instanceId={instanceId}
				config={config}
				onSaved={async () => undefined}
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

describe("moving to another instance without the page being rebuilt", () => {
	it("★ shows the instance now on screen, not the draft left over from the last one", () => {
		const { rerender } = mount({ "ChatBot.AutoEat.Threshold": "5" })
		fireEvent.change(screen.getByLabelText("Server address"), {
			target: { value: "typed-but-never-saved.example.com" },
		})

		const other = instanceConfigInput.parse({
			...CONFIG,
			serverAddress: "second.example.com",
			advancedKeys: { "ChatBot.AutoEat.Threshold": "9" },
		})
		remount(rerender, "i2", other)

		expect(screen.getByLabelText("Server address")).toHaveProperty("value", "second.example.com")
		expect(screen.getByLabelText("Value")).toHaveProperty("value", "9")
	})

	it("keeps an edit while the operator stays on the same instance", () => {
		const { rerender } = mount({})
		fireEvent.change(screen.getByLabelText("Server address"), {
			target: { value: "still-being-typed.example.com" },
		})

		remount(rerender, "i1", instanceConfigInput.parse({ ...CONFIG, advancedKeys: {} }))

		expect(screen.getByLabelText("Server address")).toHaveProperty(
			"value",
			"still-being-typed.example.com",
		)
	})
})

describe("★ what the settings save is allowed to carry", () => {
	it("sends no bot config at all, so saving settings cannot undo a bot change", async () => {
		mount({})

		await save()

		expect(mutate.mock.calls[0]?.[0]?.config).not.toHaveProperty("botConfig")
		expect(updateInstanceConfigInput.safeParse(mutate.mock.calls[0]?.[0]).success).toBe(true)
	})

	it("★ submits the instance now on screen after the operator moved to it", async () => {
		const { rerender } = mount({ "ChatBot.AutoEat.Threshold": "5" })
		const other = instanceConfigInput.parse({
			...CONFIG,
			serverAddress: "second.example.com",
			advancedKeys: { "ChatBot.AutoEat.Threshold": "9" },
		})

		remount(rerender, "i2", other)
		await save()

		expect(mutate.mock.calls[0]?.[0]?.instanceId).toBe("i2")
		expect(sentConfig()?.serverAddress).toBe("second.example.com")
		expect(sentConfig()?.advancedKeys).toEqual({ "ChatBot.AutoEat.Threshold": "9" })
	})
})

describe("discarding an edit", () => {
	it("is offered only once something has actually changed", () => {
		mount({})

		expect(screen.getByText("Discard changes")).toHaveProperty("disabled", true)

		fireEvent.change(screen.getByLabelText("Server address"), {
			target: { value: "elsewhere.example.com" },
		})

		expect(screen.getByText("Discard changes")).toHaveProperty("disabled", false)
	})

	it("★ goes quiet again after a successful save, rather than claiming unsaved work forever", async () => {
		const { rerender } = mount({ "ChatBot.AutoEat.Threshold": "5" })
		fireEvent.change(screen.getByLabelText("Value"), { target: { value: "9" } })
		expect(screen.getByText("Discard changes")).toHaveProperty("disabled", false)

		await save()
		remount(
			rerender,
			"i1",
			instanceConfigInput.parse({ ...CONFIG, advancedKeys: { "ChatBot.AutoEat.Threshold": "9" } }),
		)

		expect(screen.getByText("Discard changes")).toHaveProperty("disabled", true)
	})

	it("★ goes quiet once the saved keys arrive, even if they were added out of alphabetical order", async () => {
		const { rerender } = mount({ "ChatBot.AutoFishing.Enabled": "true" })
		fireEvent.click(screen.getByText("Add a key"))
		const added = advancedRowOf("Choose a key")
		if (added === undefined) throw new Error("expected a new row")
		fireEvent.click(added)
		const option = await screen.findByRole("option", { name: "ChatBot.AutoEat.Threshold" })
		fireEvent.pointerDown(option)
		fireEvent.pointerUp(option)
		fireEvent.click(option)
		const values = screen.getAllByLabelText("Value")
		const addedValue = values[values.length - 1]
		if (addedValue === undefined) throw new Error("expected the added row's value box")
		fireEvent.change(addedValue, { target: { value: "5" } })

		remount(
			rerender,
			"i1",
			instanceConfigInput.parse({
				...CONFIG,
				advancedKeys: {
					"ChatBot.AutoFishing.Enabled": "true",
					"ChatBot.AutoEat.Threshold": "5",
				},
			}),
		)

		expect(screen.getByText("Discard changes")).toHaveProperty("disabled", true)
	})

	it("★ stays quiet when the bots change elsewhere, which is not an edit to these settings", () => {
		const { rerender } = mount({})

		remount(
			rerender,
			"i1",
			instanceConfigInput.parse({
				...CONFIG,
				advancedKeys: {},
				botConfig: { "ChatBot.Alerts.Enabled": "true" },
			}),
		)

		expect(screen.getByText("Discard changes")).toHaveProperty("disabled", true)
	})

	it("puts the saved values back, advanced keys included", () => {
		mount({ "ChatBot.AutoEat.Threshold": "5" })
		fireEvent.change(screen.getByLabelText("Server address"), {
			target: { value: "elsewhere.example.com" },
		})
		fireEvent.change(screen.getByLabelText("Value"), { target: { value: "9" } })

		fireEvent.click(screen.getByText("Discard changes"))

		expect(screen.getByLabelText("Server address")).toHaveProperty("value", CONFIG.serverAddress)
		expect(screen.getByLabelText("Value")).toHaveProperty("value", "5")
		expect(screen.getByText("Discard changes")).toHaveProperty("disabled", true)
	})
})
