import { type InstanceConfigInput, instanceConfigInput } from "@open-mcc/contracts"
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { BotConfigDraft } from "~/lib/bot-config"
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
			"Chat log",
			"Player list log",
			"Follow a player",
			"Teleport requests",
			"Replay capture",
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

		expect(within(cardFor("Maps")).queryByLabelText("Image size in pixels")).toBeNull()
		expect(within(cardFor("Maps")).getAllByRole("radio")).toHaveLength(2)
	})

	it("shows them once it is on", () => {
		mount({ "ChatBot.Map.Enabled": "true" })

		expect(within(cardFor("Maps")).getByLabelText("Image size in pixels")).toBeDefined()
	})
})

describe("switching a bot off", () => {
	it("★ keeps every value the operator set inside it", () => {
		const onChange = mount({
			"ChatBot.Alerts.Enabled": "true",
			"ChatBot.Alerts.Log_File": "mine.txt",
			"ChatBot.Alerts.Matches": ["admin"],
		})
		const off = within(cardFor("Alerts"))
			.getAllByRole("radio")
			.find((radio) => radio.getAttribute("value") === "false")
		if (off === undefined) throw new Error("no off control on the Alerts card")

		fireEvent.click(off)

		expect(onChange).toHaveBeenCalledWith({
			"ChatBot.Alerts.Enabled": "false",
			"ChatBot.Alerts.Log_File": "mine.txt",
			"ChatBot.Alerts.Matches": ["admin"],
		})
	})
})

describe("going back to what the client would do", () => {
	it("offers that only for a setting the operator has actually set", () => {
		mount({ "ChatBot.Map.Enabled": "true", "ChatBot.Map.Resize_To": "256" })

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
			within(card).getByText("Does nothing until World and position and Nearby entities is on."),
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

describe("a bot switched off with a problem still inside it", () => {
	it("★ says so on the card, so a blocked save is never a mystery", () => {
		render(
			<BotConfigEditor
				draft={{ "ChatBot.Map.Enabled": "false", "ChatBot.Map.Resize_To": "0" }}
				issues={{ "ChatBot.Map.Resize_To": "Between 1 and 2147483647" }}
				instance={INSTANCE}
				onChange={vi.fn()}
			/>,
		)

		expect(
			within(cardFor("Maps")).getByText("Turn this back on to fix 1 setting before saving."),
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
				draft={{ "ChatBot.Map.Enabled": "true", "ChatBot.Map.Resize_To": "0" }}
				issues={{ "ChatBot.Map.Resize_To": "Between 1 and 2147483647" }}
				instance={INSTANCE}
				onChange={vi.fn()}
			/>,
		)

		expect(within(cardFor("Maps")).queryByText(/Turn this back on/)).toBeNull()
		expect(within(cardFor("Maps")).getByText("Between 1 and 2147483647")).toBeDefined()
	})
})
