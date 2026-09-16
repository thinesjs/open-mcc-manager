import {
	type InstanceConfigInput,
	type InstanceConfigView,
	instanceConfigInput,
	instanceConfigStored,
	type UpdateBotConfigInput,
	updateBotConfigInput,
} from "@open-mcc/contracts"
import type { AdvancedKeys } from "@open-mcc/contracts/boundary/mcc-config-keys"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { BotConfigPanel } from "./bot-config-panel"

const mutate = vi.fn()

vi.mock("~/lib/trpc", () => ({
	useTRPC: () => ({
		instance: { updateBotConfig: { mutationOptions: () => ({ mutationFn: mutate }) } },
	}),
}))

const BASE = {
	accountType: "offline",
	minecraftAccount: "OpenMccBot",
	serverAddress: "play.example.com:25565",
	autoRelogRetries: 3,
	autoRelogEnabled: true,
	autoRelogDelaySeconds: { min: 5, max: 20 },
	antiAfkEnabled: true,
	antiAfkIntervalSeconds: { min: 90, max: 300 },
}

const configWith = (logFile: string): InstanceConfigInput =>
	instanceConfigInput.parse({
		...BASE,
		botConfig: {
			"ChatBot.PlayerListLogger.Enabled": "true",
			"ChatBot.PlayerListLogger.File": logFile,
		},
	})

type RefetchConfig = () => Promise<InstanceConfigView | null>

const mount = (
	instanceId: string,
	config: InstanceConfigInput,
	version = 1,
	onSaved: RefetchConfig = async () => null,
) => {
	const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
	return render(
		<QueryClientProvider client={client}>
			<BotConfigPanel
				key={instanceId}
				instanceId={instanceId}
				config={config}
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
			<BotConfigPanel
				key={instanceId}
				instanceId={instanceId}
				config={config}
				version={version}
				onSaved={async () => null}
			/>
		</QueryClientProvider>,
	)
}

const sent = (): UpdateBotConfigInput | undefined => {
	const parsed = updateBotConfigInput.safeParse(mutate.mock.calls[0]?.[0])
	return parsed.success ? parsed.data : undefined
}

const PARSED_BASE = instanceConfigInput.parse(BASE)

const withKeys = (advancedKeys: AdvancedKeys): InstanceConfigInput => ({
	...PARSED_BASE,
	advancedKeys,
})

const mountKeys = (advancedKeys: AdvancedKeys) => mount("i1", withKeys(advancedKeys))

const save = async () => {
	screen.getByText("Save bots").click()
	await act(async () => undefined)
}

const cardFor = (name: string) => {
	const card = screen.getByRole("heading", { name }).closest("section")
	if (card === null) throw new Error(`no card rendered for ${name}`)
	return card
}

const turnOn = (section: string) => {
	const toggle = screen.getByRole("group", { name: `${section} on or off` })
	fireEvent.click(within(toggle).getByRole("radio", { name: "On" }))
}

const HUNGER = "Eat when hunger drops to"

beforeEach(() => {
	mutate.mockResolvedValue({ version: 2 })
})

afterEach(() => {
	cleanup()
	mutate.mockReset()
})

describe("★ saving the audited keys through the bots' own cards", () => {
	it("★ sends each key in the field it is stored in, so neither field swallows the other", async () => {
		mount(
			"i1",
			instanceConfigInput.parse({
				...BASE,
				botConfig: { "ChatBot.Map.Enabled": "true" },
				advancedKeys: { "ChatBot.AutoEat.Enabled": "true" },
			}),
		)

		await save()

		expect(sent()?.botConfig).toEqual({ "ChatBot.Map.Enabled": "true" })
		expect(sent()?.advancedKeys).toEqual({ "ChatBot.AutoEat.Enabled": "true" })
	})

	it("sends a payload the server's own contract accepts", async () => {
		mountKeys({ "ChatBot.AutoEat.Enabled": "true" })

		await save()

		expect(updateBotConfigInput.safeParse(mutate.mock.calls[0]?.[0]).success).toBe(true)
	})

	it("shows a stored key under its own bot, labelled for a person", () => {
		mountKeys({ "ChatBot.AutoEat.Enabled": "true", "ChatBot.AutoEat.Threshold": "5" })

		expect(within(cardFor("Eating")).getByLabelText(HUNGER)).toHaveProperty("value", "5")
	})

	it("★ stores the bot's own switch as an audited key when the operator turns it on", async () => {
		mountKeys({})
		turnOn("Fishing")

		await save()

		expect(sent()?.advancedKeys).toEqual({ "ChatBot.AutoFishing.Enabled": "true" })
		expect(sent()?.botConfig).toEqual({})
	})

	it("does not save at all while a value is invalid, and says why", async () => {
		mountKeys({
			"ChatBot.ItemsCollector.Enabled": "true",
			"ChatBot.ItemsCollector.Collection_Radius": "",
		})

		await save()

		expect(mutate).not.toHaveBeenCalled()
		expect(screen.getByText("Decimal number")).toBeDefined()
	})

	it("disables the save control rather than letting it look available", () => {
		mountKeys({ "ChatBot.ItemsCollector.Collection_Radius": "" })

		expect(screen.getByText("Save bots").closest("button")).toHaveProperty("disabled", true)
	})

	it("★ refuses a cooldown pair the client would swap, before it reaches the host", async () => {
		mountKeys({
			"ChatBot.AutoAttack.Enabled": "true",
			"ChatBot.AutoAttack.Cooldown_Time.Custom": "true",
			"ChatBot.AutoAttack.Cooldown_Time.Min": "3.0",
			"ChatBot.AutoAttack.Cooldown_Time.Max": "1.0",
		})

		await save()

		expect(mutate).not.toHaveBeenCalled()
		expect(screen.getByText("Above the maximum (1)")).toBeDefined()
	})

	it("saves an empty pair for an instance that has set none", async () => {
		mountKeys({})

		await save()

		expect(sent()?.advancedKeys).toEqual({})
		expect(sent()?.botConfig).toEqual({})
	})

	it("★ drops a key the operator hands back to the client", async () => {
		mountKeys({ "ChatBot.AutoEat.Enabled": "true", "ChatBot.AutoEat.Threshold": "5" })
		fireEvent.click(within(cardFor("Eating")).getByText("Use client default"))

		await save()

		expect(sent()?.advancedKeys).toEqual({ "ChatBot.AutoEat.Enabled": "true" })
	})

	it("carries a value the operator edited rather than the one it was given", async () => {
		mountKeys({ "ChatBot.AutoEat.Enabled": "true", "ChatBot.AutoEat.Threshold": "5" })
		fireEvent.change(screen.getByLabelText(HUNGER), { target: { value: "9" } })

		await save()

		expect(sent()?.advancedKeys).toEqual({
			"ChatBot.AutoEat.Enabled": "true",
			"ChatBot.AutoEat.Threshold": "9",
		})
	})
})

describe("discarding an edit to the bots", () => {
	it("is offered only once something has actually changed", () => {
		mountKeys({ "ChatBot.AutoEat.Enabled": "true", "ChatBot.AutoEat.Threshold": "5" })

		expect(screen.getByText("Discard changes")).toHaveProperty("disabled", true)

		fireEvent.change(screen.getByLabelText(HUNGER), { target: { value: "9" } })

		expect(screen.getByText("Discard changes")).toHaveProperty("disabled", false)
	})

	it("puts the saved values back", () => {
		mountKeys({ "ChatBot.AutoEat.Enabled": "true", "ChatBot.AutoEat.Threshold": "5" })
		fireEvent.change(screen.getByLabelText(HUNGER), { target: { value: "9" } })

		fireEvent.click(screen.getByText("Discard changes"))

		expect(screen.getByLabelText(HUNGER)).toHaveProperty("value", "5")
	})

	it("★ goes quiet after a save that added a bot sorting before an already-saved one", async () => {
		const { rerender } = mount("i1", configWith("first.txt"))
		const alerts = screen.getByRole("group", { name: "Alerts on or off" })
		fireEvent.click(within(alerts).getByRole("radio", { name: "On" }))
		expect(screen.getByText("Discard changes")).toHaveProperty("disabled", false)

		await save()
		remount(
			rerender,
			"i1",
			instanceConfigInput.parse({
				...BASE,
				botConfig: {
					"ChatBot.PlayerListLogger.Enabled": "true",
					"ChatBot.PlayerListLogger.File": "first.txt",
					"ChatBot.Alerts.Enabled": "true",
				},
			}),
		)

		expect(screen.getByText("Discard changes")).toHaveProperty("disabled", true)
	})

	it("★ goes quiet again after the client default is taken and the same value typed back", () => {
		mount("i1", configWith("first.txt"))
		expect(screen.getByText("Discard changes")).toHaveProperty("disabled", true)

		fireEvent.click(screen.getByText("Use client default"))
		expect(screen.getByText("Discard changes")).toHaveProperty("disabled", false)

		fireEvent.change(screen.getByLabelText("Player list file"), { target: { value: "first.txt" } })

		expect(screen.getByText("Discard changes")).toHaveProperty("disabled", true)
	})

	it("★ goes quiet once the saved keys arrive, even in a different order from the edits", () => {
		const { rerender } = mountKeys({ "ChatBot.AutoFishing.Enabled": "true" })
		turnOn("Eating")
		expect(screen.getByText("Discard changes")).toHaveProperty("disabled", false)

		remount(
			rerender,
			"i1",
			withKeys({
				"ChatBot.AutoEat.Enabled": "true",
				"ChatBot.AutoFishing.Enabled": "true",
			}),
		)

		expect(screen.getByText("Discard changes")).toHaveProperty("disabled", true)
	})
})

describe("saving the bots an operator has configured", () => {
	it("sends what is on screen, under the instance it is showing", async () => {
		mount("i1", configWith("first.txt"))

		screen.getByText("Save bots").click()
		await act(async () => undefined)

		expect(sent()?.instanceId).toBe("i1")
		expect(sent()?.botConfig["ChatBot.PlayerListLogger.File"]).toBe("first.txt")
	})
})

describe("moving to another instance without the page being rebuilt", () => {
	it("★ shows the instance now on screen, not the draft left over from the last one", () => {
		const { rerender } = mount("i1", configWith("first.txt"))
		fireEvent.change(screen.getByLabelText("Player list file"), {
			target: { value: "typed-but-never-saved.txt" },
		})

		remount(rerender, "i2", configWith("second.txt"))

		expect(screen.getByLabelText("Player list file")).toHaveProperty("value", "second.txt")
	})

	it("★ saves the second instance's values, never the first one's", async () => {
		const { rerender } = mount("i1", configWith("first.txt"))
		fireEvent.change(screen.getByLabelText("Player list file"), {
			target: { value: "typed-but-never-saved.txt" },
		})

		remount(rerender, "i2", configWith("second.txt"))
		screen.getByText("Save bots").click()
		await act(async () => undefined)

		expect(sent()?.instanceId).toBe("i2")
		expect(sent()?.botConfig["ChatBot.PlayerListLogger.File"]).toBe("second.txt")
	})

	it("keeps an edit while the operator stays on the same instance", () => {
		const { rerender } = mount("i1", configWith("first.txt"))
		fireEvent.change(screen.getByLabelText("Player list file"), {
			target: { value: "still-being-typed.txt" },
		})

		remount(rerender, "i1", configWith("first.txt"))

		expect(screen.getByLabelText("Player list file")).toHaveProperty(
			"value",
			"still-being-typed.txt",
		)
	})
})

describe("★ the version a bots save is made against", () => {
	const expectedVersions = () =>
		mutate.mock.calls.map((call) => updateBotConfigInput.parse(call[0]).expectedVersion)

	it("★ posts the version the panel was opened at, not the one that arrived meanwhile", async () => {
		const { rerender } = mount("i1", PARSED_BASE, 7)

		remount(rerender, "i1", PARSED_BASE, 8)
		await save()

		expect(expectedVersions()).toEqual([7])
	})

	it("★ posts the version the last save returned, so a second save is not a stale one", async () => {
		mount("i1", PARSED_BASE, 7)
		mutate.mockResolvedValue({ version: 8 })

		await save()
		await save()

		expect(expectedVersions()).toEqual([7, 8])
	})

	it("★ takes the bots the conflict handed back into the panel, so the retry cannot overwrite them", async () => {
		const theirs = instanceConfigStored.parse({
			...BASE,
			botConfig: { "ChatBot.Alerts.Enabled": "true" },
		})
		mount("i1", PARSED_BASE, 7, async () => ({ config: theirs, version: 9 }))
		mutate.mockRejectedValueOnce({
			message: "conflict",
			data: { errorCode: "INSTANCE_CONCURRENTLY_MODIFIED" },
		})

		await save()
		await save()

		expect(mutate.mock.calls.map((call) => updateBotConfigInput.parse(call[0]).botConfig)).toEqual([
			{},
			{ "ChatBot.Alerts.Enabled": "true" },
		])
	})

	it("★ posts the refreshed version after a conflict, not a version read a second time", async () => {
		const refetched = vi
			.fn<() => Promise<InstanceConfigView | null>>()
			.mockResolvedValueOnce({ config: instanceConfigStored.parse(PARSED_BASE), version: 9 })
			.mockResolvedValue({ config: instanceConfigStored.parse(PARSED_BASE), version: 11 })
		mount("i1", PARSED_BASE, 7, refetched)
		mutate.mockRejectedValueOnce({
			message: "conflict",
			data: { errorCode: "INSTANCE_CONCURRENTLY_MODIFIED" },
		})

		await save()
		await save()

		expect(expectedVersions()).toEqual([7, 9])
	})
})
