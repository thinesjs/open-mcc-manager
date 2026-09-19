import { type InstanceConfigInput, instanceConfigInput } from "@open-mcc/contracts"
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { BotConfigDraft } from "~/lib/bot-config"
import { BOT_CONFIG_FIELDS } from "~/lib/bot-config-fields"
import { BotConfigEditor } from "./bot-config-editor"

const INSTANCE: InstanceConfigInput = instanceConfigInput.parse({
	accountType: "offline",
	minecraftAccount: "OpenMccBot",
	serverAddress: "play.example.com:25565",
	autoRelogRetries: 3,
	autoRelogEnabled: true,
	autoRelogDelaySeconds: { min: 5, max: 20 },
	antiAfkEnabled: true,
	antiAfkIntervalSeconds: { min: 90, max: 300 },
})

afterEach(cleanup)

const mount = (draft: BotConfigDraft, onChange = vi.fn()) => {
	render(<BotConfigEditor draft={draft} issues={{}} instance={INSTANCE} onChange={onChange} />)
	return onChange
}

const cardFor = (name: string) => {
	const heading = screen.getByRole("heading", { name })
	const card = heading.closest("section")
	if (card === null) throw new Error(`no card rendered for ${name}`)
	return card
}

describe("what the page shows before anything is opened", () => {
	it("lists every bot the operator may configure, in order and with nothing left out", () => {
		mount({})

		expect(
			screen.getAllByRole("heading", { level: 3 }).map((heading) => heading.textContent),
		).toEqual([
			"Alerts",
			"Maps",
			"Mail",
			"Player list log",
			"Follow a player",
			"Teleport requests",
			"Replay capture",
			"Fishing",
			"Digging",
			"Attacking",
			"Item collector",
			"Crafting",
			"Farming",
			"Eating",
			"Dropping items",
		])
	})

	it("shows each bot's own on and off state without a click", () => {
		mount({ "ChatBot.Map.Enabled": "true" })
		const map = within(cardFor("Maps")).getAllByRole("radio")

		expect(map.find((radio) => radio.getAttribute("value") === "true")).toHaveProperty(
			"checked",
			true,
		)
	})

	it("keeps a bot's settings out of sight until it is switched on", () => {
		mount({})

		expect(
			within(cardFor("Maps")).queryByRole("group", { name: "Notify on the first map received" }),
		).toBeNull()
		expect(within(cardFor("Maps")).getAllByRole("radio")).toHaveLength(2)
	})

	it("shows them once it is on", () => {
		mount({ "ChatBot.Map.Enabled": "true" })

		expect(
			within(cardFor("Maps")).getByRole("group", { name: "Notify on the first map received" }),
		).toBeDefined()
	})
})

describe("switching a bot off", () => {
	it("★ keeps every value the operator set inside it", () => {
		const onChange = mount({
			"ChatBot.Alerts.Enabled": "true",
			"ChatBot.PlayerListLogger.File": "mine.txt",
			"ChatBot.Alerts.Matches": ["admin"],
		})
		const off = within(cardFor("Alerts"))
			.getAllByRole("radio")
			.find((radio) => radio.getAttribute("value") === "false")
		if (off === undefined) throw new Error("no off control on the Alerts card")

		fireEvent.click(off)

		expect(onChange).toHaveBeenCalledWith({
			"ChatBot.Alerts.Enabled": "false",
			"ChatBot.PlayerListLogger.File": "mine.txt",
			"ChatBot.Alerts.Matches": ["admin"],
		})
	})
})

describe("going back to what the client would do", () => {
	it("offers that only for a setting the operator has actually set", () => {
		mount({ "ChatBot.Map.Enabled": "true", "ChatBot.Map.Notify_On_First_Update": "true" })

		expect(within(cardFor("Maps")).getAllByText("Use client default")).toHaveLength(1)
	})

	it("offers nothing to reset on a bot whose settings are all still the client's", () => {
		mount({ "ChatBot.Mailer.Enabled": "true" })

		expect(within(cardFor("Mail")).queryAllByText("Use client default")).toEqual([])
	})

	it("★ leaves the bot's own switch without one, because switching it off is a choice worth enforcing", () => {
		mount({ "ChatBot.Mailer.Enabled": "false" })
		const card = within(cardFor("Mail"))

		expect(card.queryAllByText("Use client default")).toEqual([])
		expect(
			card.getAllByRole("radio").find((radio) => radio.getAttribute("value") === "false"),
		).toHaveProperty("checked", true)
	})
})

describe("a setting that does nothing yet", () => {
	it("says which other setting has to be on first", () => {
		mount({ "ChatBot.Alerts.Enabled": "true" })

		expect(
			within(cardFor("Alerts")).getAllByText(/Does nothing until Alert on matched words is on/),
		).not.toHaveLength(0)
	})
})

describe("a bot that needs something the instance has not turned on", () => {
	it("★ says so on the section's own card, where the switch that does nothing lives", () => {
		mount({})
		const card = cardFor("Follow a player")

		expect(
			within(card).getByText(
				"Does nothing until these are on: World and position, Nearby entities.",
			),
		).toBeDefined()
	})

	it("says nothing once the instance provides both", () => {
		render(
			<BotConfigEditor
				draft={{}}
				issues={{}}
				instance={{ ...INSTANCE, worldDataEnabled: true, entityDataEnabled: true }}
				onChange={vi.fn()}
			/>,
		)

		expect(within(cardFor("Follow a player")).queryByText(/Does nothing until/)).toBeNull()
	})
})

describe("a requirement the whole bot shares", () => {
	it("is said once on the card, not again under every setting", () => {
		mount({ "ChatBot.AutoFishing.Enabled": "true" })

		expect(
			within(cardFor("Fishing")).getAllByText("Does nothing until Nearby entities is on."),
		).toHaveLength(1)
	})

	it("still names a setting's own extra requirement under it", () => {
		mount({ "ChatBot.AutoFishing.Enabled": "true" })
		const rods = fieldFor(BOT_CONFIG_FIELDS["ChatBot.AutoFishing.Durability_Limit"].label)

		expect(
			within(rods).getByText("Does nothing until these are on: Inventory, Nearby entities."),
		).toBeDefined()
	})
})

describe("a bot switched off with a problem still inside it", () => {
	it("★ says so on the card, so a blocked save is never a mystery", () => {
		render(
			<BotConfigEditor
				draft={{ "ChatBot.Mailer.Enabled": "false", "ChatBot.Mailer.MaxMailsPerPlayer": "0" }}
				issues={{ "ChatBot.Mailer.MaxMailsPerPlayer": "Between 1 and 2147483647" }}
				instance={INSTANCE}
				onChange={vi.fn()}
			/>,
		)

		expect(
			within(cardFor("Mail")).getByText("Turn this back on to fix 1 setting before saving."),
		).toBeDefined()
	})

	it("says nothing when the switched-off bot has no problem in it", () => {
		render(
			<BotConfigEditor
				draft={{ "ChatBot.Map.Enabled": "false" }}
				issues={{}}
				instance={INSTANCE}
				onChange={vi.fn()}
			/>,
		)

		expect(within(cardFor("Maps")).queryByText(/Turn this back on/)).toBeNull()
	})

	it("shows the field's own error instead once the bot is open", () => {
		render(
			<BotConfigEditor
				draft={{ "ChatBot.Mailer.Enabled": "true", "ChatBot.Mailer.MaxMailsPerPlayer": "0" }}
				issues={{ "ChatBot.Mailer.MaxMailsPerPlayer": "Between 1 and 2147483647" }}
				instance={INSTANCE}
				onChange={vi.fn()}
			/>,
		)

		expect(within(cardFor("Mail")).queryByText(/Turn this back on/)).toBeNull()
		expect(within(cardFor("Mail")).getByText("Between 1 and 2147483647")).toBeDefined()
	})
})

const fieldFor = (label: string) => {
	const container = screen.getByText(label, { selector: "span" }).parentElement?.parentElement
	if (container === null || container === undefined) throw new Error(`no field for ${label}`)
	return container
}

describe("★ the eight bots that had no page of their own", () => {
	it("offers each choice in words rather than the client's own spelling", () => {
		mount({ "ChatBot.AutoDrop.Enabled": "true" })
		const mode = within(cardFor("Dropping items")).getByRole("group", { name: "What to drop" })

		expect(within(mode).getByRole("radio", { name: "Only the listed items" })).toBeDefined()
		expect(
			within(mode).getByRole("radio", { name: "Everything but the listed items" }),
		).toBeDefined()
		expect(within(mode).getByRole("radio", { name: "Everything" })).toBeDefined()
	})

	it("★ tells the operator a farm needs world AND inventory, on the Farming card", () => {
		mount({})

		expect(
			within(cardFor("Farming")).getByText(
				"Does nothing until these are on: World and position, Inventory.",
			),
		).toBeDefined()
	})

	it("★ names both settings under moving between spots, not only the one the section needs", () => {
		mount({ "ChatBot.AutoFishing.Enabled": "true" })
		const move = fieldFor(BOT_CONFIG_FIELDS["ChatBot.AutoFishing.Enable_Move"].label)

		expect(
			within(move).getByText(
				"Does nothing until these are on: World and position, Nearby entities.",
			),
		).toBeDefined()
	})

	it("★ says nothing under the bite warm-up with both detection toggles off", () => {
		render(
			<BotConfigEditor
				draft={{
					"ChatBot.AutoFishing.Enabled": "true",
					"ChatBot.AutoFishing.Enable_Velocity_Detection": "false",
					"ChatBot.AutoFishing.Enable_Sound_Detection": "false",
				}}
				issues={{}}
				instance={{ ...INSTANCE, entityDataEnabled: true }}
				onChange={vi.fn()}
			/>,
		)
		const warmup = fieldFor(BOT_CONFIG_FIELDS["ChatBot.AutoFishing.Detection_Warmup"].label)
		const threshold = fieldFor(
			BOT_CONFIG_FIELDS["ChatBot.AutoFishing.Velocity_Hook_Threshold"].label,
		)

		expect(within(threshold).getByText(/Does nothing until/)).toBeDefined()
		expect(within(warmup).queryByText(/Does nothing until/)).toBeNull()
	})
})
