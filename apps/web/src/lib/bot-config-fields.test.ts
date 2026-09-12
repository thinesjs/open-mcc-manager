import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { readMccConfigKeys } from "@open-mcc/contracts/boundary/mcc-config"
import {
	BOT_CONFIG_NAMES,
	type BotConfigName,
	SETTING_NAMES,
	SETTING_SHAPE,
} from "@open-mcc/contracts/boundary/mcc-config-keys"
import { describe, expect, it } from "vitest"
import {
	BOT_CONFIG_DEPENDENCIES,
	BOT_CONFIG_FIELDS,
	BOT_CONFIG_SECTIONS,
} from "./bot-config-fields"

const REGISTERED = new Set<string>(BOT_CONFIG_NAMES)
const EXTERNAL_SETTINGS = new Set<string>(["worldDataEnabled", "entityDataEnabled"])

describe("the field table against the registry it is written for", () => {
	it("gives every entry a label", () => {
		expect(Object.values(BOT_CONFIG_FIELDS).filter((field) => field.label.trim() === "")).toEqual(
			[],
		)
	})
})

describe("the sections an operator reads the fields under", () => {
	const sectioned: readonly string[] = BOT_CONFIG_SECTIONS.flatMap((section) => [...section.keys])

	it("names seven sections", () => {
		expect(BOT_CONFIG_SECTIONS.map((section) => section.name)).toEqual([
			"Alerts",
			"Map",
			"Mailer",
			"PlayerListLogger",
			"FollowPlayer",
			"RemoteControl",
			"ReplayCapture",
		])
	})

	it("places every registered key in a section, so none is unreachable", () => {
		expect(BOT_CONFIG_NAMES.filter((name) => !sectioned.includes(name))).toEqual([])
	})

	it("places no key twice and none the registry does not hold", () => {
		expect(new Set(sectioned).size).toBe(sectioned.length)
		expect(sectioned.filter((key) => !REGISTERED.has(key))).toEqual([])
	})

	it("puts the section's own key under the section it names", () => {
		for (const section of BOT_CONFIG_SECTIONS) {
			expect(section.keys.filter((key) => key.split(".")[1] !== section.name)).toEqual([])
		}
	})

	it("leads each section with its Enabled toggle", () => {
		for (const section of BOT_CONFIG_SECTIONS) {
			expect(section.keys[0]).toBe(`ChatBot.${section.name}.Enabled`)
		}
	})
})

describe("the fields that do nothing until another setting is on", () => {
	const nearestFor = (key: string): string | undefined => {
		const rule = BOT_CONFIG_DEPENDENCIES.find((dependency) => {
			const claimed: readonly string[] = dependency.keys
			return claimed.includes(key)
		})
		return rule === undefined || rule.kind !== "sibling" ? undefined : rule.requires
	}

	it("names the prerequisite nearest each field, not a distant one that leaves a step out", () => {
		expect(nearestFor("ChatBot.Alerts.Matches")).toBe("ChatBot.Alerts.Trigger_By_Words")
		expect(nearestFor("ChatBot.RemoteControl.AutoTpaccept_Everyone")).toBe(
			"ChatBot.RemoteControl.AutoTpaccept",
		)
	})

	it("claims each field once and ends every chain, which is what lets the walk terminate", () => {
		const claimed = BOT_CONFIG_DEPENDENCIES.flatMap((dependency) => [...dependency.keys])
		expect(new Set(claimed).size).toBe(claimed.length)

		for (const key of claimed) {
			const seen = new Set<string>([key])
			let current = nearestFor(key)
			while (current !== undefined) {
				expect(seen.has(current)).toBe(false)
				seen.add(current)
				current = nearestFor(current)
			}
		}
	})

	it("names only registered keys as the fields it makes inert", () => {
		for (const dependency of BOT_CONFIG_DEPENDENCIES) {
			expect(dependency.keys.filter((key) => !REGISTERED.has(key))).toEqual([])
			expect(dependency.keys.length).toBeGreaterThan(0)
		}
	})

	it("points a sibling rule at a registered key in the same section", () => {
		for (const dependency of BOT_CONFIG_DEPENDENCIES) {
			if (dependency.kind !== "sibling") continue
			expect(REGISTERED.has(dependency.requires)).toBe(true)
			const section = dependency.requires.split(".")[1]
			expect(dependency.keys.filter((key) => key.split(".")[1] !== section)).toEqual([])
		}
	})

	it("points the one instance rule at the two settings outside this registry", () => {
		const instanceRules = BOT_CONFIG_DEPENDENCIES.filter(
			(dependency) => dependency.kind === "instance",
		)

		expect(instanceRules).toHaveLength(1)
		for (const rule of instanceRules) {
			if (rule.kind !== "instance") continue
			expect(rule.requires.filter((setting) => !EXTERNAL_SETTINGS.has(setting))).toEqual([])
			expect([...rule.requires].sort()).toEqual(["entityDataEnabled", "worldDataEnabled"])
		}
	})

	it("makes the whole FollowPlayer section inert rather than one field of it", () => {
		const followPlayer = BOT_CONFIG_SECTIONS.find((section) => section.name === "FollowPlayer")
		const rule = BOT_CONFIG_DEPENDENCIES.find((dependency) => dependency.kind === "instance")

		expect([...(rule?.keys ?? [])].sort()).toEqual([...(followPlayer?.keys ?? [])].sort())
	})
})

describe("the one description that carries a risk", () => {
	const field = BOT_CONFIG_FIELDS["ChatBot.RemoteControl.AutoTpaccept_Everyone"]

	it("tells the operator that any player can do it", () => {
		expect(field.description).toContain("Any player on the server")
		expect(field.description).toContain("no need to be a bot owner")
	})

	it("names the setting it depends on", () => {
		expect(field.description).toContain("Accept teleport requests")
	})

	it("is one of the few fields carrying a description, so the rest stay lean", () => {
		const described = Object.entries(BOT_CONFIG_FIELDS)
			.filter(([, entry]) => entry.description !== undefined)
			.map(([key]) => key)
			.sort()

		expect(described).toEqual([
			"ChatBot.AutoAttack.List_Mode",
			"ChatBot.AutoDig.Auto_Start_Delay",
			"ChatBot.AutoDig.Dig_Timeout",
			"ChatBot.AutoDig.Durability_Limit",
			"ChatBot.AutoDig.List_Type",
			"ChatBot.AutoDrop.Mode",
			"ChatBot.AutoEat.Threshold",
			"ChatBot.AutoFishing.Durability_Limit",
			"ChatBot.AutoFishing.Enable_Move",
			"ChatBot.ItemsCollector.Collect_All_Item_Types",
			"ChatBot.RemoteControl.AutoTpaccept",
			"ChatBot.RemoteControl.AutoTpaccept_Everyone",
			"ChatBot.ReplayCapture.Backup_Interval",
		])
	})

	it("says what the snapshot sentinel means, which no label could carry", () => {
		const entry = BOT_CONFIG_FIELDS["ChatBot.ReplayCapture.Backup_Interval"]

		expect(entry.description).toContain("-1 or 0")
		expect(entry.description).toContain("still saved")
	})
})

describe("the defaults the client itself declares", () => {
	it("holds the client's real placeholder lists, so inheriting is not mistaken for empty", () => {
		expect(BOT_CONFIG_FIELDS["ChatBot.Alerts.Matches"].clientDefault).toEqual([
			"Yourname",
			" whispers ",
			"-> me",
			"admin",
			".com",
		])
		expect(BOT_CONFIG_FIELDS["ChatBot.Alerts.Excludes"].clientDefault).toContain("myserver.com")
	})

	it("keeps the defaults a reader would otherwise get wrong", () => {
		expect(BOT_CONFIG_FIELDS["ChatBot.RemoteControl.AutoTpaccept"].clientDefault).toBe("true")
		expect(BOT_CONFIG_FIELDS["ChatBot.ReplayCapture.Backup_Interval"].clientDefault).toBe("300.0")
	})
})

describe("★ every default the editor shows, against the client's own captured config", () => {
	const here = dirname(fileURLToPath(import.meta.url))
	const fixture = readFileSync(
		join(here, "../../../../packages/contracts/src/boundary/mcc-config-fixture.ini"),
		"utf8",
	)
	const NAMES: readonly BotConfigName[] = BOT_CONFIG_SECTIONS.flatMap((section) => [
		...section.keys,
	])
	const clientDefaults = readMccConfigKeys(fixture, NAMES).values

	const MANAGED_INSTEAD: Readonly<Record<string, string>> = {
		"ChatBot.ChatLog.Log_File": "chatlog.txt",
	}

	it("matches the client on every scalar it does not deliberately manage", () => {
		const wrong = NAMES.filter((name) => {
			const ours = BOT_CONFIG_FIELDS[name].clientDefault
			const managed = MANAGED_INSTEAD[name]
			if (managed !== undefined) return ours !== managed
			const theirs = clientDefaults.get(name)
			if (theirs === undefined || typeof theirs === "object") return false
			if (typeof ours !== "string") return true
			return typeof theirs === "number" ? Number(ours) !== theirs : ours !== String(theirs)
		})

		expect(wrong).toEqual([])
	})

	it("checked a real number of them, not an empty set", () => {
		expect(clientDefaults.size).toBeGreaterThan(20)
	})
})

describe("★ the client defaults the table claims", () => {
	it("★ every one parses under its own schema, so no field starts out invalid", () => {
		const refused = SETTING_NAMES.filter(
			(name) => !SETTING_SHAPE[name].safeParse(BOT_CONFIG_FIELDS[name].clientDefault).success,
		)

		expect(refused).toEqual([])
	})

	it("★ names every registered setting, so none reaches the editor without copy", () => {
		expect(Object.keys(BOT_CONFIG_FIELDS).sort()).toEqual([...SETTING_NAMES].sort())
	})
})
