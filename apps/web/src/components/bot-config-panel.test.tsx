import {
	type InstanceConfigInput,
	instanceConfigInput,
	type UpdateBotConfigInput,
	updateBotConfigInput,
} from "@open-mcc/contracts"
import type { AdvancedKeys } from "@open-mcc/contracts/boundary/mcc-config-keys"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
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
		botConfig: { "ChatBot.ChatLog.Enabled": "true", "ChatBot.ChatLog.Log_File": logFile },
	})

const mount = (instanceId: string, config: InstanceConfigInput) => {
	const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
	return render(
		<QueryClientProvider client={client}>
			<BotConfigPanel instanceId={instanceId} config={config} onSaved={async () => undefined} />
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
			<BotConfigPanel instanceId={instanceId} config={config} onSaved={async () => undefined} />
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

const advancedRowOf = (label: string) =>
	screen.getAllByRole("combobox").find((trigger) => trigger.textContent === label)

afterEach(() => {
	cleanup()
	mutate.mockReset()
})

describe("saving the advanced keys an operator has set", () => {
	it("forwards a valid key alongside the bots", async () => {
		mountKeys({ "ChatBot.AutoEat.Enabled": "true" })

		await save()

		expect(mutate).toHaveBeenCalledTimes(1)
		expect(sent()?.advancedKeys).toEqual({ "ChatBot.AutoEat.Enabled": "true" })
	})

	it("sends a payload the server's own contract accepts", async () => {
		mountKeys({ "ChatBot.AutoEat.Enabled": "true" })

		await save()

		expect(updateBotConfigInput.safeParse(mutate.mock.calls[0]?.[0]).success).toBe(true)
	})

	it("renders a stored key as a row the operator can see", () => {
		mountKeys({ "ChatBot.AutoEat.Threshold": "5" })

		expect(advancedRowOf("ChatBot.AutoEat.Threshold")).toBeDefined()
	})

	it("does not save at all while a value is invalid, and says why", async () => {
		mountKeys({ "ChatBot.ItemsCollector.Collection_Radius": "" })

		await save()

		expect(mutate).not.toHaveBeenCalled()
		expect(screen.getByText("Decimal number")).toBeDefined()
	})

	it("disables the save control rather than letting it look available", () => {
		mountKeys({ "ChatBot.ItemsCollector.Collection_Radius": "" })

		expect(screen.getByText("Save bots").closest("button")).toHaveProperty("disabled", true)
	})

	it("loses nothing when the operator adds a row and never chooses a key", async () => {
		mountKeys({})
		fireEvent.click(screen.getByText("Add a key"))
		fireEvent.change(screen.getByLabelText("Value"), { target: { value: "1.5" } })

		await save()

		expect(mutate).not.toHaveBeenCalled()
		expect(screen.queryAllByText("Choose a key").length).toBeGreaterThan(0)
	})

	it("saves an empty object for an instance that has set none", async () => {
		mountKeys({})

		await save()

		expect(sent()?.advancedKeys).toEqual({})
	})

	it("drops a key the operator removed", async () => {
		mountKeys({ "ChatBot.AutoEat.Enabled": "true", "ChatBot.AutoFishing.Auto_Start": "false" })
		const removes = screen.getAllByText("Remove")
		await act(async () => {
			removes[1]?.click()
		})

		expect(screen.getAllByText("Remove")).toHaveLength(1)
		await save()

		expect(sent()?.advancedKeys).toEqual({ "ChatBot.AutoEat.Enabled": "true" })
	})

	it("carries a value the operator edited rather than the one it was given", async () => {
		mountKeys({ "ChatBot.AutoEat.Threshold": "5" })
		fireEvent.change(screen.getByLabelText("Value"), { target: { value: "9" } })

		await save()

		expect(sent()?.advancedKeys).toEqual({ "ChatBot.AutoEat.Threshold": "9" })
	})
})

describe("discarding an edit to the bots", () => {
	it("is offered only once something has actually changed", () => {
		mountKeys({ "ChatBot.AutoEat.Threshold": "5" })

		expect(screen.getByText("Discard changes")).toHaveProperty("disabled", true)

		fireEvent.change(screen.getByLabelText("Value"), { target: { value: "9" } })

		expect(screen.getByText("Discard changes")).toHaveProperty("disabled", false)
	})

	it("puts the saved values back", () => {
		mountKeys({ "ChatBot.AutoEat.Threshold": "5" })
		fireEvent.change(screen.getByLabelText("Value"), { target: { value: "9" } })

		fireEvent.click(screen.getByText("Discard changes"))

		expect(screen.getByLabelText("Value")).toHaveProperty("value", "5")
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
					"ChatBot.ChatLog.Enabled": "true",
					"ChatBot.ChatLog.Log_File": "first.txt",
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

		fireEvent.change(screen.getByLabelText("Chat log file"), { target: { value: "first.txt" } })

		expect(screen.getByText("Discard changes")).toHaveProperty("disabled", true)
	})

	it("★ goes quiet once the saved keys arrive, even if they were added out of alphabetical order", async () => {
		const { rerender } = mountKeys({ "ChatBot.AutoFishing.Enabled": "true" })
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
			withKeys({
				"ChatBot.AutoFishing.Enabled": "true",
				"ChatBot.AutoEat.Threshold": "5",
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
		expect(sent()?.botConfig["ChatBot.ChatLog.Log_File"]).toBe("first.txt")
	})
})

describe("moving to another instance without the page being rebuilt", () => {
	it("★ shows the instance now on screen, not the draft left over from the last one", () => {
		const { rerender } = mount("i1", configWith("first.txt"))
		fireEvent.change(screen.getByLabelText("Chat log file"), {
			target: { value: "typed-but-never-saved.txt" },
		})

		remount(rerender, "i2", configWith("second.txt"))

		expect(screen.getByLabelText("Chat log file")).toHaveProperty("value", "second.txt")
	})

	it("★ saves the second instance's values, never the first one's", async () => {
		const { rerender } = mount("i1", configWith("first.txt"))
		fireEvent.change(screen.getByLabelText("Chat log file"), {
			target: { value: "typed-but-never-saved.txt" },
		})

		remount(rerender, "i2", configWith("second.txt"))
		screen.getByText("Save bots").click()
		await act(async () => undefined)

		expect(sent()?.instanceId).toBe("i2")
		expect(sent()?.botConfig["ChatBot.ChatLog.Log_File"]).toBe("second.txt")
	})

	it("keeps an edit while the operator stays on the same instance", () => {
		const { rerender } = mount("i1", configWith("first.txt"))
		fireEvent.change(screen.getByLabelText("Chat log file"), {
			target: { value: "still-being-typed.txt" },
		})

		remount(rerender, "i1", configWith("first.txt"))

		expect(screen.getByLabelText("Chat log file")).toHaveProperty("value", "still-being-typed.txt")
	})
})
