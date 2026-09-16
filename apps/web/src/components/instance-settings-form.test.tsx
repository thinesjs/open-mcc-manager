import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import type { InstanceConfigInput } from "@open-mcc/contracts"
import { instanceConfigInput, updateInstanceConfigInput } from "@open-mcc/contracts"
import type { AdvancedKeys } from "@open-mcc/contracts/boundary/mcc-config-keys"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { INSTANCE_SETTING_LABELS } from "~/lib/bot-config-fields"
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
				key="i1"
				instanceId="i1"
				config={{ ...CONFIG, advancedKeys }}
				version={1}
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
				key={instanceId}
				instanceId={instanceId}
				config={config}
				version={1}
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

describe("★ the three client-data toggles the bots depend on", () => {
	it("★ shows them with live control off, because bots need them and live control does not gate them", () => {
		mount({})

		expect(screen.getByRole("group", { name: "World and position" })).toBeDefined()
		expect(screen.getByRole("group", { name: "Inventory" })).toBeDefined()
		expect(screen.getByRole("group", { name: "Nearby entities" })).toBeDefined()
	})

	it("★ renders a control for every setting the bots' dependency copy names", () => {
		mount({})

		for (const label of Object.values(INSTANCE_SETTING_LABELS)) {
			expect(screen.getByRole("group", { name: label })).toBeDefined()
		}
	})

	it("keeps showing them when live control is on", () => {
		const { rerender } = mount({})
		remount(rerender, "i2", instanceConfigInput.parse({ ...CONFIG, liveControlEnabled: true }))

		expect(screen.getByRole("group", { name: "World and position" })).toBeDefined()
		expect(screen.getByRole("group", { name: "Inventory" })).toBeDefined()
		expect(screen.getByRole("group", { name: "Nearby entities" })).toBeDefined()
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
		expect(sentConfig()).not.toHaveProperty("advancedKeys")
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
		const { rerender } = mount({})
		fireEvent.change(screen.getByLabelText("Server address"), {
			target: { value: "saved.example.com" },
		})
		expect(screen.getByText("Discard changes")).toHaveProperty("disabled", false)

		await save()
		remount(
			rerender,
			"i1",
			instanceConfigInput.parse({ ...CONFIG, serverAddress: "saved.example.com" }),
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

	it("puts the saved values back", () => {
		mount({})
		fireEvent.change(screen.getByLabelText("Server address"), {
			target: { value: "elsewhere.example.com" },
		})

		fireEvent.click(screen.getByText("Discard changes"))

		expect(screen.getByLabelText("Server address")).toHaveProperty("value", CONFIG.serverAddress)
		expect(screen.getByText("Discard changes")).toHaveProperty("disabled", true)
	})
})
