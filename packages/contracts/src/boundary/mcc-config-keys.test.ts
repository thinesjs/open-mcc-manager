import { describe, expect, it } from "vitest"
import {
	ADVANCED_BOOLEAN_NAMES,
	ADVANCED_BOOLEAN_SHAPE,
	ADVANCED_ENUM_NAMES,
	ADVANCED_ENUM_SHAPE,
	ADVANCED_KEY_NAMES,
	ADVANCED_KEY_SHAPE,
	ADVANCED_LITERAL_SHAPE,
	ADVANCED_NUMBER_SHAPE,
	advancedKeysSchema,
} from "./mcc-config-keys"

const VALID_VALUES: Readonly<Record<string, string>> = {
	"ChatBot.AutoAttack.Mode": "single",
	"ChatBot.AutoAttack.Priority": "distance",
	"ChatBot.AutoAttack.Interaction": "Interact",
	"ChatBot.AutoAttack.List_Mode": "blacklist",
	"ChatBot.AutoCraft.OnFailure": "abort",
	"ChatBot.AutoDig.Mode": "lookat",
	"ChatBot.AutoDig.Location_Order": "distance",
	"ChatBot.AutoDig.List_Type": "blacklist",
	"ChatBot.AutoDrop.Mode": "include",
	"ChatBot.AutoAttack.Enabled": "true",
	"ChatBot.AutoAttack.Cooldown_Time.Custom": "true",
	"ChatBot.AutoAttack.Cooldown_Time.RandomMode": "true",
	"ChatBot.AutoAttack.Cooldown_Time.Min": "1.5",
	"ChatBot.AutoAttack.Cooldown_Time.Max": "1.5",
	"ChatBot.AutoAttack.Attack_Range": "1.5",
	"ChatBot.AutoAttack.Attack_Hostile": "true",
	"ChatBot.AutoAttack.Attack_Passive": "true",
	"ChatBot.AutoCraft.Enabled": "true",
	"ChatBot.AutoCraft.CraftingTable.X": "1.5",
	"ChatBot.AutoCraft.CraftingTable.Y": "1.5",
	"ChatBot.AutoCraft.CraftingTable.Z": "1.5",
	"ChatBot.AutoDig.Enabled": "true",
	"ChatBot.AutoDig.Auto_Tool_Switch": "true",
	"ChatBot.AutoDig.Apply_Efficiency_Enchantments": "true",
	"ChatBot.AutoDig.Apply_Haste_Effects": "true",
	"ChatBot.AutoDig.Durability_Limit": "1",
	"ChatBot.AutoDig.Drop_Low_Durability_Tools": "true",
	"ChatBot.AutoDig.Auto_Start_Delay": "1.5",
	"ChatBot.AutoDig.Dig_Timeout": "1.5",
	"ChatBot.AutoDig.Log_Block_Dig": "true",
	"ChatBot.AutoDrop.Enabled": "true",
	"ChatBot.AutoEat.Enabled": "true",
	"ChatBot.AutoEat.Threshold": "1",
	"ChatBot.AutoFishing.Enabled": "true",
	"ChatBot.AutoFishing.Antidespawn": "true",
	"ChatBot.AutoFishing.Mainhand": "true",
	"ChatBot.AutoFishing.Auto_Start": "true",
	"ChatBot.AutoFishing.Cast_Delay": "1.5",
	"ChatBot.AutoFishing.Fishing_Delay": "1.5",
	"ChatBot.AutoFishing.Fishing_Timeout": "1.5",
	"ChatBot.AutoFishing.Durability_Limit": "1.5",
	"ChatBot.AutoFishing.Auto_Rod_Switch": "true",
	"ChatBot.AutoFishing.Stationary_Threshold": "1.5",
	"ChatBot.AutoFishing.Hook_Threshold": "1.5",
	"ChatBot.AutoFishing.Enable_Velocity_Detection": "true",
	"ChatBot.AutoFishing.Velocity_Hook_Threshold": "0.0",
	"ChatBot.AutoFishing.Enable_Sound_Detection": "true",
	"ChatBot.AutoFishing.Sound_Distance": "1.5",
	"ChatBot.AutoFishing.Detection_Warmup": "1.5",
	"ChatBot.AutoFishing.Log_Fish_Bobber": "true",
	"ChatBot.AutoFishing.Enable_Move": "true",
	"ChatBot.Farmer.Enabled": "true",
	"ChatBot.Farmer.Delay_Between_Tasks": "1.5",
	"ChatBot.ItemsCollector.Enabled": "true",
	"ChatBot.ItemsCollector.Collect_All_Item_Types": "true",
	"ChatBot.ItemsCollector.Delay_Between_Tasks": "100",
	"ChatBot.ItemsCollector.Collection_Radius": "1.5",
	"ChatBot.ItemsCollector.Always_Return_To_Start": "true",
	"ChatBot.ItemsCollector.Prioritize_Clusters": "true",
}

const GOLDEN_KEYS: readonly string[] = Object.keys(VALID_VALUES)

const SCHEMAS = new Map(Object.entries(ADVANCED_KEY_SHAPE))

describe("the registry the operator may write to", () => {
	it("holds exactly the keys that were audited, no more and no fewer", () => {
		expect([...ADVANCED_KEY_NAMES].sort()).toEqual([...GOLDEN_KEYS].sort())
	})

	it("accepts every audited key's own valid literal", () => {
		const refused = GOLDEN_KEYS.filter((name) => {
			const schema = SCHEMAS.get(name)
			if (schema === undefined) return true
			return !schema.safeParse(VALID_VALUES[name]).success
		})

		expect(refused).toEqual([])
	})

	it("splits into an enum half and a literal half that do not overlap and miss nothing", () => {
		const enumNames = Object.keys(ADVANCED_ENUM_SHAPE)
		const literalNames = Object.keys(ADVANCED_LITERAL_SHAPE)

		expect(enumNames.filter((name) => literalNames.includes(name))).toEqual([])
		expect([...enumNames, ...literalNames].sort()).toEqual([...GOLDEN_KEYS].sort())
	})

	it("★ splits the literal half into booleans and numbers that do not overlap and miss nothing", () => {
		const booleanNames = Object.keys(ADVANCED_BOOLEAN_SHAPE)
		const numberNames = Object.keys(ADVANCED_NUMBER_SHAPE)

		expect(booleanNames.filter((name) => numberNames.includes(name))).toEqual([])
		expect([...booleanNames, ...numberNames].sort()).toEqual(
			Object.keys(ADVANCED_LITERAL_SHAPE).sort(),
		)
	})

	it("★ names every advanced boolean, so a toggle is never rendered as a text box", () => {
		expect([...ADVANCED_BOOLEAN_NAMES].sort()).toEqual(Object.keys(ADVANCED_BOOLEAN_SHAPE).sort())
	})

	it("★ every key called a boolean takes true and false, and refuses a number", () => {
		const wrong = Object.entries(ADVANCED_BOOLEAN_SHAPE).filter(
			([, schema]) =>
				!schema.safeParse("true").success ||
				!schema.safeParse("false").success ||
				schema.safeParse("1.5").success,
		)

		expect(wrong.map(([name]) => name)).toEqual([])
	})

	it("★ every key called a number refuses true, so a text box is never rendered as a toggle", () => {
		const wrong = Object.entries(ADVANCED_NUMBER_SHAPE).filter(
			([, schema]) => schema.safeParse("true").success,
		)

		expect(wrong.map(([name]) => name)).toEqual([])
	})

	it("★ orders the audited names itself, so no consumer inherits the declaration order", () => {
		expect([...ADVANCED_KEY_NAMES]).toEqual(
			[...ADVANCED_KEY_NAMES].sort((left, right) => left.localeCompare(right)),
		)
	})

	it("names the enum half as the renderer's quoting list", () => {
		expect([...ADVANCED_ENUM_NAMES].sort()).toEqual(Object.keys(ADVANCED_ENUM_SHAPE).sort())
	})

	it("refuses a key nobody audited, whatever it is called", () => {
		const refused = advancedKeysSchema.safeParse({ "ChatBot.AutoAttack.Action": "send /hello" })

		expect(refused.success).toBe(false)
	})
})

const refusalFor = (name: string, value: string): readonly string[] => {
	const schema = SCHEMAS.get(name)
	if (schema === undefined) throw new Error(`${name} is not registered`)
	const result = schema.safeParse(value)
	return result.success ? [] : result.error.issues.map((issue) => issue.message)
}

describe("the shapes a value has to take", () => {
	it.each(["00", "01", "-00", "-0"])(
		"refuses the integer %s, which TOML would misread",
		(value) => {
			expect(refusalFor("ChatBot.ItemsCollector.Delay_Between_Tasks", value)).not.toEqual([])
		},
	)

	it.each(["01.0", "00.1"])("refuses the float %s for the same reason", (value) => {
		expect(refusalFor("ChatBot.AutoAttack.Attack_Range", value)).not.toEqual([])
	})

	it.each(["1.0\nB = 2", "1.0 "])("refuses %j, so nothing can be appended to a value", (value) => {
		expect(refusalFor("ChatBot.AutoDig.Auto_Start_Delay", value)).not.toEqual([])
	})

	it.each(["2147483648", "-2147483649"])(
		"refuses the integer %s, which C# int cannot hold",
		(value) => {
			expect(refusalFor("ChatBot.AutoDig.Durability_Limit", value)).not.toEqual([])
		},
	)

	it("accepts the largest integer C# int can hold", () => {
		expect(refusalFor("ChatBot.AutoDig.Durability_Limit", "2147483647")).toEqual([])
	})

	it.each([
		"ChatBot.AutoDig.Durability_Limit",
		"ChatBot.AutoEat.Threshold",
		"ChatBot.ItemsCollector.Delay_Between_Tasks",
	])("refuses a negative on %s, because the client would rewrite it", (key) => {
		expect(refusalFor(key, "-1")).not.toEqual([])
	})

	it.each([
		"1.1234567",
		"1234567890123456.7",
		"0.00000000000000001",
		"100000000000000000.0",
		"1.12345678901234567",
		"1000000000000000000000000000000.0",
	])("accepts the float %s, because nothing here compares float text", (value) => {
		expect(refusalFor("ChatBot.AutoFishing.Hook_Threshold", value)).toEqual([])
	})

	it("still refuses something that is not a decimal at all", () => {
		for (const value of ["1.", ".5", "1e9", "01.5", "--1.0", ""]) {
			expect(refusalFor("ChatBot.AutoFishing.Hook_Threshold", value)).toEqual(["Decimal number"])
		}
	})

	it("★ refuses a decimal so long the client could not hold it as a number", () => {
		expect(refusalFor("ChatBot.AutoFishing.Hook_Threshold", `${"9".repeat(400)}.0`)).toEqual([
			"Decimal number",
		])
	})

	it("says one thing at a time, so a malformed number never reads as a range problem", () => {
		expect(refusalFor("ChatBot.AutoDig.Auto_Start_Delay", "nonsense")).toEqual(["Decimal number"])
	})

	it("refuses a float where a boolean belongs", () => {
		expect(refusalFor("ChatBot.AutoEat.Enabled", "4.0")).not.toEqual([])
	})

	it("refuses a boolean where a float belongs", () => {
		expect(refusalFor("ChatBot.AutoFishing.Hook_Threshold", "true")).not.toEqual([])
	})

	it.each(["Punch", "blacklist", "attack"])(
		"refuses %s on an enum that does not list it, including the wrong case",
		(value) => {
			expect(refusalFor("ChatBot.AutoAttack.Interaction", value)).not.toEqual([])
		},
	)
})

describe("what a refusal tells the operator", () => {
	it.each([
		{
			named: "an integer",
			key: "ChatBot.AutoDig.Durability_Limit",
			says: "Whole number, no leading zeroes",
		},
		{ named: "a float", key: "ChatBot.AutoFishing.Hook_Threshold", says: "Decimal number" },
		{ named: "a boolean", key: "ChatBot.AutoEat.Enabled", says: "Must be true or false" },
		{ named: "an enum", key: "ChatBot.AutoAttack.Interaction", says: "Choose a value" },
	])("says what $named key wants, in one message rather than zod's own", ({ key, says }) => {
		expect(refusalFor(key, "")).toEqual([says])
	})

	it("says the range rather than the shape when only the magnitude is wrong", () => {
		expect(refusalFor("ChatBot.AutoEat.Threshold", "9999999999")).toEqual(["Between 0 and 20"])
	})

	it("never stacks two complaints on one value, whatever is wrong with it", () => {
		const stacked = GOLDEN_KEYS.flatMap((name) =>
			["", "abc", "-5", "9999999999", "99999.999999", "true", "1.5", "1", "0", "0.0"]
				.map((value) => ({ name, value, issues: refusalFor(name, value) }))
				.filter((probe) => probe.issues.length > 1),
		)

		expect(stacked).toEqual([])
	})
})

describe("the bounds the client would otherwise rewrite behind the operator's back", () => {
	it.each([
		{ key: "ChatBot.AutoAttack.Attack_Range", value: "5.0", says: "Between 1 and 4" },
		{ key: "ChatBot.AutoAttack.Attack_Range", value: "0.5", says: "Between 1 and 4" },
		{ key: "ChatBot.AutoEat.Threshold", value: "25", says: "Between 0 and 20" },
		{
			key: "ChatBot.AutoDig.Auto_Start_Delay",
			value: "0.05",
			says: "0.1 or more, or negative",
		},
		{ key: "ChatBot.AutoDig.Dig_Timeout", value: "0.05", says: "0.1 or more, or negative" },
		{ key: "ChatBot.AutoFishing.Cast_Delay", value: "-1.0", says: "0 or more" },
		{ key: "ChatBot.AutoFishing.Fishing_Delay", value: "-1.0", says: "0 or more" },
		{ key: "ChatBot.AutoFishing.Fishing_Timeout", value: "-1.0", says: "0 or more" },
		{ key: "ChatBot.AutoFishing.Durability_Limit", value: "65.0", says: "Between 0 and 64" },
		{ key: "ChatBot.AutoFishing.Stationary_Threshold", value: "-1.0", says: "0 or more" },
		{ key: "ChatBot.AutoFishing.Hook_Threshold", value: "-1.0", says: "0 or more" },
		{ key: "ChatBot.AutoFishing.Velocity_Hook_Threshold", value: "1.5", says: "0 or less" },
		{ key: "ChatBot.AutoFishing.Sound_Distance", value: "-1.0", says: "0 or more" },
		{ key: "ChatBot.AutoFishing.Detection_Warmup", value: "-1.0", says: "0 or more" },
		{ key: "ChatBot.Farmer.Delay_Between_Tasks", value: "0.5", says: "1 or more" },
		{
			key: "ChatBot.ItemsCollector.Delay_Between_Tasks",
			value: "50",
			says: "Between 100 and 2147483647",
		},
	])(
		"refuses $value on $key rather than letting the client silently rewrite it",
		({ key, value, says }) => {
			expect(refusalFor(key, value)).toEqual([says])
		},
	)
})

describe("what a value can never smuggle into the rendered document", () => {
	it.each(["1.5\nB = 2", "1.5 ", "[Main.General]", "1.5 # comment", '1.5"', "1.5]", "1.5\r"])(
		"refuses %j on every key that renders its value unquoted",
		(value) => {
			const admitted = GOLDEN_KEYS.filter(
				(name) => !ADVANCED_ENUM_NAMES.includes(name) && refusalFor(name, value).length === 0,
			)

			expect(admitted).toEqual([])
		},
	)
})

describe("the negative the client keeps, and means something by", () => {
	it.each(["ChatBot.AutoDig.Auto_Start_Delay", "ChatBot.AutoDig.Dig_Timeout"])(
		"accepts a negative on %s, which the client passes through unchanged",
		(key) => {
			expect(refusalFor(key, "-1.0")).toEqual([])
		},
	)

	it.each(["ChatBot.AutoAttack.Cooldown_Time.Min", "ChatBot.AutoAttack.Cooldown_Time.Max"])(
		"leaves %s unbounded here, because the client only clamps it when the custom cooldown is on",
		(key) => {
			expect(refusalFor(key, "0.0")).toEqual([])
		},
	)
})
