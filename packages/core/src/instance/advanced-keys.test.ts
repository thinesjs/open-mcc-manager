import {
	ADVANCED_ENUM_NAMES,
	ADVANCED_ENUM_SHAPE,
	ADVANCED_KEY_NAMES,
	ADVANCED_KEY_SHAPE,
	type AdvancedKeys,
} from "@open-mcc/contracts/boundary/mcc-config-keys"
import { describe, expect, it } from "vitest"
import { defaultInstanceConfig, renderInstanceConfig } from "./config"
import { compareInstanceConfig, describeConfigDrift, isOperatorKey } from "./config-drift"

const BASE = defaultInstanceConfig({
	accountType: "offline",
	minecraftAccount: "OpenMccBot",
	serverAddress: "100.101.102.103",
})

const CANDIDATES = [
	"0",
	"1",
	"2",
	"20",
	"100",
	"150",
	"0.0",
	"-0.2",
	"-1.5",
	"1.5",
	"2.5",
	"64.0",
] as const

const SCHEMAS = new Map(Object.entries(ADVANCED_KEY_SHAPE))
const ENUM_SCHEMAS = new Map(Object.entries(ADVANCED_ENUM_SHAPE))

const valueFor = (name: string, second: boolean): string => {
	const members = ENUM_SCHEMAS.get(name)
	if (members !== undefined) {
		const chosen = second ? members.options[1] : members.options[0]
		return chosen ?? members.options[0]
	}
	const schema = SCHEMAS.get(name)
	if (schema === undefined) throw new Error(`${name} is not registered`)
	if (schema.safeParse("true").success) return second ? "false" : "true"
	const accepted = CANDIDATES.filter((candidate) => schema.safeParse(candidate).success)
	const chosen = second ? accepted[1] : accepted[0]
	if (chosen === undefined) throw new Error(`${name} accepts fewer than two candidate values`)
	return chosen
}

const everyKey = (second: boolean): AdvancedKeys => {
	const keys: AdvancedKeys = {}
	for (const name of ADVANCED_KEY_NAMES) {
		Object.assign(keys, { [name]: valueFor(name, second) })
	}
	return keys
}

const literalDocument = (keys: AdvancedKeys): string => {
	const tables = new Map<string, string[]>()
	for (const [name, value] of Object.entries(keys)) {
		if (value === undefined) continue
		const separator = name.lastIndexOf(".")
		const rendered = ADVANCED_ENUM_NAMES.includes(name) ? `"${value}"` : value
		const lines = tables.get(name.slice(0, separator)) ?? []
		lines.push(`${name.slice(separator + 1)} = ${rendered}`)
		tables.set(name.slice(0, separator), lines)
	}
	return [...tables.entries()]
		.map(([table, lines]) => [`[${table}]`, ...lines].join("\n"))
		.join("\n")
}

describe("who owns a registered key", () => {
	it("counts every registered key as the operator's, and nothing else", () => {
		expect(ADVANCED_KEY_NAMES.filter((name) => !isOperatorKey(name))).toEqual([])
	})

	it.each(["Main.General.AccountType", "ChatBot.McpServer.Enabled", "Main.Advanced.Language"])(
		"does not count the managed key %s as the operator's",
		(name) => {
			expect(isOperatorKey(name)).toBe(false)
		},
	)
})

describe("drift on the keys the operator saved", () => {
	it("reports every one of the 59 when the host holds a different value for each", () => {
		const drift = compareInstanceConfig(
			literalDocument(everyKey(false)),
			literalDocument(everyKey(true)),
		)

		expect(
			drift
				.filter((entry) => entry.kind === "operator")
				.map((entry) => entry.key)
				.sort(),
		).toEqual([...ADVANCED_KEY_NAMES].sort())
	})

	it("reports nothing when the host holds exactly what was saved", () => {
		const document = literalDocument(everyKey(false))

		expect(compareInstanceConfig(document, document)).toEqual([])
	})

	it("says nothing about a registered key the host sets that was never saved here, because the client writes its own defaults for all of them", () => {
		const drift = compareInstanceConfig(
			literalDocument({}),
			literalDocument({ "ChatBot.AutoEat.Threshold": "31337" }),
		)

		expect(drift).toEqual([])
	})

	it("still reports a saved key the host has lost", () => {
		const drift = compareInstanceConfig(
			literalDocument({ "ChatBot.AutoEat.Threshold": "5" }),
			literalDocument({}),
		)

		expect(drift).toEqual([
			{ kind: "operator", key: "ChatBot.AutoEat.Threshold", expected: 5, actual: undefined },
		])
	})
})

describe("what the manager says about that drift", () => {
	it("keeps the host's value out of its own sentence", () => {
		const said = describeConfigDrift({
			kind: "operator",
			key: "ChatBot.AutoEat.Threshold",
			expected: 5,
			actual: 31337,
		})

		expect(said).toBe("ChatBot.AutoEat.Threshold does not match the saved value")
		expect(said).not.toContain("31337")
	})

	it("says the same thing when the host has no value at all, which the payload cannot tell apart", () => {
		expect(
			describeConfigDrift({
				kind: "operator",
				key: "ChatBot.AutoEat.Threshold",
				expected: 5,
				actual: undefined,
			}),
		).toBe("ChatBot.AutoEat.Threshold does not match the saved value")
	})
})

describe("how a saved key reaches the client's config file", () => {
	it("puts two keys of one table under a single header, so the document still parses", () => {
		const rendered = renderInstanceConfig({
			...BASE,
			advancedKeys: {
				"ChatBot.AutoFishing.Cast_Delay": "1.5",
				"ChatBot.AutoFishing.Fishing_Delay": "2.5",
			},
		})

		expect(rendered).toContain("[ChatBot.AutoFishing]\nCast_Delay = 1.5\nFishing_Delay = 2.5")
		expect(rendered.split("[ChatBot.AutoFishing]")).toHaveLength(2)
	})

	it("quotes an enum value and leaves the scalars bare", () => {
		const rendered = renderInstanceConfig({
			...BASE,
			advancedKeys: { "ChatBot.AutoAttack.Mode": "single", "ChatBot.AutoAttack.Enabled": "true" },
		})

		expect(rendered).toContain('Mode = "single"')
		expect(rendered).toContain("Enabled = true")
	})

	it("writes nothing at all for an instance that has saved none, which is every existing one", () => {
		const rendered = renderInstanceConfig({ ...BASE, advancedKeys: {} })

		expect(rendered.trimEnd().endsWith("LogToFile = false")).toBe(true)
		expect(rendered).not.toContain("[ChatBot.AutoEat]")
	})

	it("survives render, parse and compare with no drift, across all four value forms", () => {
		const advancedKeys: AdvancedKeys = {
			"ChatBot.AutoFishing.Velocity_Hook_Threshold": "-0.2",
			"ChatBot.ItemsCollector.Delay_Between_Tasks": "2147483647",
			"ChatBot.AutoEat.Enabled": "true",
			"ChatBot.AutoAttack.Interaction": "InteractAt",
		}
		const rendered = renderInstanceConfig({ ...BASE, advancedKeys })

		expect(compareInstanceConfig(rendered, rendered)).toEqual([])
	})

	it("round-trips every one of the 59 through one document", () => {
		const rendered = renderInstanceConfig({ ...BASE, advancedKeys: everyKey(false) })

		expect(compareInstanceConfig(rendered, rendered)).toEqual([])
	})
})
