import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { readMccConfigKeys } from "@open-mcc/contracts/boundary/mcc-config"
import {
	CLIENT_DEFAULT_FILES,
	SETTING_ENUM_SHAPE,
	SETTING_NAMES,
	SETTING_SHAPE,
	type SettingName,
} from "@open-mcc/contracts/boundary/mcc-config-keys"
import { describe, expect, it } from "vitest"
import {
	BOT_CONFIG_DEPENDENCIES,
	BOT_CONFIG_ENUM_OPTIONS,
	BOT_CONFIG_FIELDS,
	BOT_CONFIG_SECTION_PURPOSE,
	BOT_CONFIG_SECTIONS,
	type BotConfigEnumOption,
	INSTANCE_SETTING_LABELS,
} from "./bot-config-fields"

const REGISTERED = new Set<string>(SETTING_NAMES)
const EXTERNAL_SETTINGS = new Set<string>([
	"worldDataEnabled",
	"inventoryDataEnabled",
	"entityDataEnabled",
])

const ruleFor = (key: string) =>
	BOT_CONFIG_DEPENDENCIES.find((dependency) => {
		const claimed: readonly string[] = dependency.keys
		return claimed.includes(key)
	})

const siblingFor = (key: string): string | undefined => {
	const rule = ruleFor(key)
	return rule === undefined || rule.kind !== "sibling" ? undefined : rule.requires
}

const instanceNeedsFor = (key: string): readonly string[] | undefined => {
	const rule = ruleFor(key)
	return rule === undefined || rule.kind !== "instance" ? undefined : [...rule.requires].sort()
}

describe("the field table against the registry it is written for", () => {
	it("gives every entry a label", () => {
		expect(Object.values(BOT_CONFIG_FIELDS).filter((field) => field.label.trim() === "")).toEqual(
			[],
		)
	})
})

describe("the sections an operator reads the fields under", () => {
	const sectioned: readonly string[] = BOT_CONFIG_SECTIONS.flatMap((section) => [...section.keys])

	it("names fifteen sections, the eight newer bots after the seven that shipped first", () => {
		expect(BOT_CONFIG_SECTIONS.map((section) => section.name)).toEqual([
			"Alerts",
			"Map",
			"Mailer",
			"PlayerListLogger",
			"FollowPlayer",
			"RemoteControl",
			"ReplayCapture",
			"AutoFishing",
			"AutoDig",
			"AutoAttack",
			"ItemsCollector",
			"AutoCraft",
			"Farmer",
			"AutoEat",
			"AutoDrop",
		])
	})

	it("★ places every registered key in a section, the audited ones included, so none is unreachable", () => {
		expect(SETTING_NAMES.filter((name) => !sectioned.includes(name))).toEqual([])
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

	it("★ reads each detection threshold straight after the toggle that gates it", () => {
		const fishing = BOT_CONFIG_SECTIONS.find((section) => section.name === "AutoFishing")
		const keys: readonly string[] = fishing?.keys ?? []
		const after = (key: string) => keys[keys.indexOf(key) + 1]

		expect(after("ChatBot.AutoFishing.Enable_Velocity_Detection")).toBe(
			"ChatBot.AutoFishing.Velocity_Hook_Threshold",
		)
		expect(after("ChatBot.AutoFishing.Enable_Sound_Detection")).toBe(
			"ChatBot.AutoFishing.Sound_Distance",
		)
	})
})

describe("the choices an operator picks between", () => {
	const OPTIONS = new Map<string, readonly BotConfigEnumOption[]>(
		Object.entries(BOT_CONFIG_ENUM_OPTIONS),
	)

	it("★ offers exactly the values the client accepts for every enum, no more and no fewer", () => {
		for (const [name, schema] of Object.entries(SETTING_ENUM_SHAPE)) {
			const offered = (OPTIONS.get(name) ?? []).map((option) => option.value).sort()
			expect([name, offered]).toEqual([name, [...schema.options].sort()])
		}
	})

	it("words every choice, and never two the same way within one setting", () => {
		for (const [name, options] of OPTIONS) {
			const labels = options.map((option) => option.label)
			expect([name, labels.filter((label) => label.trim() === "")]).toEqual([name, []])
			expect([name, new Set(labels).size]).toEqual([name, labels.length])
		}
	})
})

describe("the fields that do nothing until another setting is on", () => {
	it("names the prerequisite nearest each field, not a distant one that leaves a step out", () => {
		expect(siblingFor("ChatBot.Alerts.Matches")).toBe("ChatBot.Alerts.Trigger_By_Words")
		expect(siblingFor("ChatBot.RemoteControl.AutoTpaccept_Everyone")).toBe(
			"ChatBot.RemoteControl.AutoTpaccept",
		)
		expect(siblingFor("ChatBot.AutoDig.Durability_Limit")).toBe("ChatBot.AutoDig.Auto_Tool_Switch")
		expect(siblingFor("ChatBot.AutoDig.Drop_Low_Durability_Tools")).toBe(
			"ChatBot.AutoDig.Auto_Tool_Switch",
		)
		expect(siblingFor("ChatBot.AutoFishing.Velocity_Hook_Threshold")).toBe(
			"ChatBot.AutoFishing.Enable_Velocity_Detection",
		)
		expect(siblingFor("ChatBot.AutoFishing.Sound_Distance")).toBe(
			"ChatBot.AutoFishing.Enable_Sound_Detection",
		)
	})

	it("★ claims each field once and ends every chain, which is what lets the walk terminate", () => {
		const claimed = BOT_CONFIG_DEPENDENCIES.flatMap((dependency) => [...dependency.keys])
		expect(claimed.filter((key, index) => claimed.indexOf(key) !== index)).toEqual([])

		for (const key of claimed) {
			const seen = new Set<string>([key])
			let current = siblingFor(key)
			while (current !== undefined) {
				expect(seen.has(current)).toBe(false)
				seen.add(current)
				current = siblingFor(current)
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

	it("★ points every instance rule only at the three client-data settings", () => {
		for (const dependency of BOT_CONFIG_DEPENDENCIES) {
			if (dependency.kind !== "instance") continue
			expect(dependency.requires.filter((setting) => !EXTERNAL_SETTINGS.has(setting))).toEqual([])
		}
	})

	it("★ words every client-data setting a rule can name, and no other", () => {
		expect(Object.keys(INSTANCE_SETTING_LABELS).sort()).toEqual([...EXTERNAL_SETTINGS].sort())
	})

	it("makes the whole FollowPlayer section inert rather than one field of it", () => {
		const followPlayer = BOT_CONFIG_SECTIONS.find((section) => section.name === "FollowPlayer")

		for (const key of followPlayer?.keys ?? []) {
			expect(instanceNeedsFor(key)).toEqual(["entityDataEnabled", "worldDataEnabled"])
		}
	})
})

describe("★ what each of the eight bots needs from the instance", () => {
	const SECTION_NEEDS = [
		{ section: "AutoAttack", needs: ["entityDataEnabled"] },
		{ section: "ItemsCollector", needs: ["entityDataEnabled", "worldDataEnabled"] },
		{ section: "AutoDrop", needs: ["inventoryDataEnabled"] },
		{ section: "AutoCraft", needs: ["inventoryDataEnabled"] },
		{ section: "AutoDig", needs: ["worldDataEnabled"] },
		{ section: "Farmer", needs: ["inventoryDataEnabled", "worldDataEnabled"] },
		{ section: "AutoFishing", needs: ["entityDataEnabled"] },
		{ section: "AutoEat", needs: ["inventoryDataEnabled"] },
	] as const

	it.each(SECTION_NEEDS)("gates the $section switch on $needs", ({ section, needs }) => {
		expect(instanceNeedsFor(`ChatBot.${section}.Enabled`)).toEqual(needs)
	})

	it.each(SECTION_NEEDS)(
		"★ leaves no $section field ungated, unless it carries a rule of its own",
		({ section }) => {
			const found = BOT_CONFIG_SECTIONS.find((entry) => entry.name === section)
			expect((found?.keys ?? []).filter((key) => ruleFor(key) === undefined)).toEqual([])
		},
	)

	const PER_KEY_NEEDS = [
		{ key: "ChatBot.AutoFishing.Enable_Move", needs: ["entityDataEnabled", "worldDataEnabled"] },
		{
			key: "ChatBot.AutoFishing.Durability_Limit",
			needs: ["entityDataEnabled", "inventoryDataEnabled"],
		},
		{
			key: "ChatBot.AutoFishing.Auto_Rod_Switch",
			needs: ["entityDataEnabled", "inventoryDataEnabled"],
		},
		{
			key: "ChatBot.AutoDig.Auto_Tool_Switch",
			needs: ["inventoryDataEnabled", "worldDataEnabled"],
		},
	] as const

	it.each(PER_KEY_NEEDS)(
		"★ gives $key both its own need and its section's, because an instance rule never chains",
		({ key, needs }) => {
			expect(instanceNeedsFor(key)).toEqual(needs)
		},
	)

	it("★ never adds terrain to crafting, which was checked against the client and rejected", () => {
		for (const key of ["ChatBot.AutoCraft.Enabled", "ChatBot.AutoCraft.CraftingTable.X"]) {
			expect(instanceNeedsFor(key)).toEqual(["inventoryDataEnabled"])
		}
	})

	it("★ ties the bite warm-up and the dig timing options to no sibling, only to their section", () => {
		expect(siblingFor("ChatBot.AutoFishing.Detection_Warmup")).toBeUndefined()
		expect(instanceNeedsFor("ChatBot.AutoFishing.Detection_Warmup")).toEqual(["entityDataEnabled"])
		for (const key of [
			"ChatBot.AutoDig.Apply_Efficiency_Enchantments",
			"ChatBot.AutoDig.Apply_Haste_Effects",
		]) {
			expect(siblingFor(key)).toBeUndefined()
			expect(instanceNeedsFor(key)).toEqual(["worldDataEnabled"])
		}
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
			"ChatBot.AutoDig.Mode",
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

describe("★ the copy an operator needs so a bot never surprises them", () => {
	const copyOf = (key: SettingName): string =>
		`${BOT_CONFIG_FIELDS[key].label} ${BOT_CONFIG_FIELDS[key].description ?? ""}`

	it("★ says moving between spots STOPS the bot, not merely that it waits", () => {
		expect(copyOf("ChatBot.AutoFishing.Enable_Move")).toContain("stops fishing")
	})

	it("★ never ties the bite warm-up to either detection toggle, because every catch waits for it", () => {
		const warmup = copyOf("ChatBot.AutoFishing.Detection_Warmup")
		for (const toggle of [
			"ChatBot.AutoFishing.Enable_Velocity_Detection",
			"ChatBot.AutoFishing.Enable_Sound_Detection",
		] as const) {
			expect(warmup).not.toContain(BOT_CONFIG_FIELDS[toggle].label)
		}
		expect(warmup).not.toMatch(/movement|splash|sound|velocity/i)
	})

	it.each([
		"ChatBot.AutoAttack.List_Mode",
		"ChatBot.AutoDig.List_Type",
		"ChatBot.AutoDig.Mode",
		"ChatBot.AutoDrop.Mode",
		"ChatBot.AutoFishing.Enable_Move",
		"ChatBot.ItemsCollector.Collect_All_Item_Types",
	] as const)("★ says the list behind %s is the client's own", (key) => {
		expect(copyOf(key)).toMatch(/client's own|cannot be edited here/)
	})

	it("★ never offers interact-at as both, because the client sends one interact-at and no attack", () => {
		const interactAt = BOT_CONFIG_ENUM_OPTIONS["ChatBot.AutoAttack.Interaction"].find(
			(option) => option.value === "InteractAt",
		)
		expect(interactAt?.label).toBe("Interact at its position")
	})

	it("★ says the crafting recipes are the client's own, since no field stands for them", () => {
		expect(BOT_CONFIG_SECTION_PURPOSE.AutoCraft).toContain("client's own")
		expect(BOT_CONFIG_SECTION_PURPOSE.AutoCraft).toContain("cannot be edited here")
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
		expect(BOT_CONFIG_FIELDS["ChatBot.AutoFishing.Durability_Limit"].clientDefault).toBe("2.0")
		expect(BOT_CONFIG_FIELDS["ChatBot.AutoDig.Durability_Limit"].clientDefault).toBe("2")
	})
})

describe("★ every default the editor shows, against the client's own captured config", () => {
	const here = dirname(fileURLToPath(import.meta.url))
	const fixture = readFileSync(
		join(here, "../../../../packages/contracts/src/boundary/mcc-config-fixture.ini"),
		"utf8",
	)
	const NAMES: readonly SettingName[] = BOT_CONFIG_SECTIONS.flatMap((section) => [...section.keys])
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
		expect(clientDefaults.size).toBeGreaterThan(70)
	})
})

describe("★ the client defaults the table claims", () => {
	it("★ every one parses under its own schema, so no field starts out invalid", () => {
		const refused = SETTING_NAMES.filter(
			(name) => !SETTING_SHAPE[name].safeParse(BOT_CONFIG_FIELDS[name].clientDefault).success,
		)

		expect(refused).toEqual([])
	})

	it("★ claims the same default file names the collector and the shared-file rule use", () => {
		const files = new Map(Object.entries(CLIENT_DEFAULT_FILES))
		const claimed = new Map(
			SETTING_NAMES.filter((name) => files.has(name)).map(
				(name) => [name, BOT_CONFIG_FIELDS[name].clientDefault] as const,
			),
		)

		expect(files.size).toBe(3)
		expect(claimed).toEqual(files)
	})

	it("★ names every registered setting, so none reaches the editor without copy", () => {
		expect(Object.keys(BOT_CONFIG_FIELDS).sort()).toEqual([...SETTING_NAMES].sort())
	})
})
