import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import type { InstanceConfigInput, InstanceConfigView } from "@open-mcc/contracts"
import {
	instanceConfigInput,
	instanceConfigStored,
	updateInstanceConfigInput,
} from "@open-mcc/contracts"
import type { AdvancedKeys } from "@open-mcc/contracts/boundary/mcc-config-keys"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { INSTANCE_SETTING_LABELS } from "~/lib/bot-config-fields"
import { InstanceSettingsForm } from "./instance-settings-form"

const here = dirname(fileURLToPath(import.meta.url))
const form = readFileSync(join(here, "instance-settings-form.tsx"), "utf8")
const detail = readFileSync(
	join(here, "..", "routes", "_authenticated.instances.$instanceId.tsx"),
	"utf8",
)
const tabs = readFileSync(join(here, "instance-config-tabs.tsx"), "utf8")

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

const propsOf = (component: string): string => {
	const start = tabs.indexOf(`<${component}`)
	return start < 0 ? "" : tabs.slice(start, tabs.indexOf("/>", start))
}

describe("where the operator edits these settings", () => {
	it("★ puts the form on the page itself, so it has room to grow and works on a phone", () => {
		expect(tabs).toContain("<InstanceSettingsForm")
		expect(tabs).not.toContain("<Modal")
		expect(detail).not.toContain("<Modal")
	})

	it("keeps no second read-only copy of the same values to drift out of step", () => {
		expect(detail).not.toContain("formatDelaySeconds(")
		expect(tabs).not.toContain("formatDelaySeconds(")
	})

	it("gives the bots their own page too, rather than burying them in the same form", () => {
		expect(tabs).toContain("<BotConfigPanel")
	})

	it("★ keys each form to its instance, so a draft cannot follow the operator to another bot", () => {
		expect(propsOf("InstanceSettingsForm")).toContain("key={instanceId}")
		expect(propsOf("BotConfigPanel")).toContain("key={instanceId}")
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

type RefetchConfig = () => Promise<InstanceConfigView | null>

const mount = (
	advancedKeys: AdvancedKeys,
	version = 1,
	onSaved: RefetchConfig = async () => null,
) => {
	const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
	return render(
		<QueryClientProvider client={client}>
			<InstanceSettingsForm
				key="i1"
				instanceId="i1"
				config={{ ...CONFIG, advancedKeys }}
				version={version}
				onSaved={onSaved}
			/>
		</QueryClientProvider>,
	)
}

const remount = (
	rerender: (element: React.ReactElement) => void,
	instanceId: string,
	config: InstanceConfigInput,
	version = 1,
) => {
	const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
	rerender(
		<QueryClientProvider client={client}>
			<InstanceSettingsForm
				key={instanceId}
				instanceId={instanceId}
				config={config}
				version={version}
				onSaved={async () => null}
			/>
		</QueryClientProvider>,
	)
}

const rerenderWith = (
	rerender: (element: React.ReactElement) => void,
	version: number,
	onSaved: RefetchConfig = async () => null,
) => {
	const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
	rerender(
		<QueryClientProvider client={client}>
			<InstanceSettingsForm
				key="i1"
				instanceId="i1"
				config={{ ...CONFIG, advancedKeys: {} }}
				version={version}
				onSaved={onSaved}
			/>
		</QueryClientProvider>,
	)
}

const save = async () => {
	screen.getByText("Save settings").click()
	await act(async () => undefined)
}

const sentConfig = () => mutate.mock.calls[0]?.[0]?.config

beforeEach(() => {
	mutate.mockResolvedValue({ version: 2 })
})

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

describe("★ the version a save is made against", () => {
	const expectedVersions = () =>
		mutate.mock.calls.map((call) => updateInstanceConfigInput.parse(call[0]).expectedVersion)

	it("★ posts the version the form was opened at, not the one that arrived meanwhile", async () => {
		const { rerender } = mount({}, 7)

		rerenderWith(rerender, 8)
		await save()

		expect(expectedVersions()).toEqual([7])
	})

	it("★ posts the version the last save returned, so a second save is not a stale one", async () => {
		mount({}, 7)
		mutate.mockResolvedValue({ version: 8 })

		await save()
		await save()

		expect(expectedVersions()).toEqual([7, 8])
	})

	it("★ takes the document the conflict handed back into the form, so the retry cannot overwrite it", async () => {
		const theirs = instanceConfigStored.parse({ ...CONFIG, serverAddress: "theirs.example.com" })
		mount({}, 7, async () => ({ config: theirs, version: 9 }))
		fireEvent.change(screen.getByLabelText("Server address"), {
			target: { value: "mine.example.com" },
		})
		mutate.mockRejectedValueOnce({
			message: "conflict",
			data: { errorCode: "INSTANCE_CONCURRENTLY_MODIFIED" },
		})

		await save()
		await save()

		expect(
			mutate.mock.calls.map(
				(call) => updateInstanceConfigInput.parse(call[0]).config.serverAddress,
			),
		).toEqual(["mine.example.com", "theirs.example.com"])
		expect(screen.getByLabelText("Server address")).toHaveProperty("value", "theirs.example.com")
	})

	it("★ posts the refreshed version after a conflict, not a version read a second time", async () => {
		const refetched = vi
			.fn<() => Promise<InstanceConfigView | null>>()
			.mockResolvedValueOnce({ config: instanceConfigStored.parse(CONFIG), version: 9 })
			.mockResolvedValue({ config: instanceConfigStored.parse(CONFIG), version: 11 })
		mount({}, 7, refetched)
		mutate.mockRejectedValueOnce({
			message: "conflict",
			data: { errorCode: "INSTANCE_CONCURRENTLY_MODIFIED" },
		})

		await save()
		await save()

		expect(expectedVersions()).toEqual([7, 9])
	})

	it("★ keeps the version it holds when the bot is busy, so the retry is not a stale save", async () => {
		const refetched = async () => ({
			config: instanceConfigStored.parse(CONFIG),
			version: 9,
		})
		mount({}, 7, refetched)
		mutate.mockRejectedValueOnce({
			message: "busy",
			data: { errorCode: "INSTANCE_BUSY" },
		})

		await save()
		await save()

		expect(expectedVersions()).toEqual([7, 7])
	})

	it("★ leaves a pending save on the last instance unable to write this one's version", async () => {
		let resolveFirst = (_result: { version: number }): void => undefined
		mutate.mockImplementationOnce(
			async () =>
				await new Promise<{ version: number }>((resolve) => {
					resolveFirst = resolve
				}),
		)
		const { rerender } = mount({}, 7)

		await save()
		remount(rerender, "i2", instanceConfigInput.parse(CONFIG), 3)
		await act(async () => {
			resolveFirst({ version: 8 })
		})
		await save()

		expect(expectedVersions()).toEqual([7, 3])
	})
})

describe("★ what a save that lost the race tells the operator", () => {
	const alertText = async () => (await screen.findByRole("alert")).textContent

	const theirs = () =>
		instanceConfigStored.parse({ ...CONFIG, serverAddress: "theirs.example.com" })

	it("★ says someone else saved first, and shows the settings that operator saved", async () => {
		mount({}, 7, async () => ({ config: theirs(), version: 9 }))
		fireEvent.change(screen.getByLabelText("Server address"), {
			target: { value: "mine.example.com" },
		})
		mutate.mockRejectedValueOnce({
			message: "conflict",
			data: { errorCode: "INSTANCE_CONCURRENTLY_MODIFIED" },
		})

		await save()

		expect(await alertText()).toBe(
			"Someone else saved first, so your changes were not saved. The form now shows theirs.",
		)
		expect(screen.getByLabelText("Server address")).toHaveProperty("value", "theirs.example.com")
	})

	it("★ says the bot is busy instead, and leaves the operator's typing on screen", async () => {
		mount({}, 7, async () => ({ config: theirs(), version: 9 }))
		fireEvent.change(screen.getByLabelText("Server address"), {
			target: { value: "mine.example.com" },
		})
		mutate.mockRejectedValueOnce({ message: "busy", data: { errorCode: "INSTANCE_BUSY" } })

		await save()

		expect(await alertText()).toBe("This bot is busy with another change. Try again in a moment.")
		expect(screen.getByLabelText("Server address")).toHaveProperty("value", "mine.example.com")
	})
})
