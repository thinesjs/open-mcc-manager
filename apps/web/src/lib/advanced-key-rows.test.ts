import type { AdvancedKeyRow } from "@open-mcc/contracts/boundary/mcc-config-keys"
import { describe, expect, it } from "vitest"
import {
	addAdvancedKeyRow,
	advancedKeyRowsFrom,
	advancedKeysFromRows,
	editAdvancedKeyRow,
	removeAdvancedKeyRow,
	selectAdvancedKeyRow,
	validateAdvancedKeyRows,
} from "./advanced-key-rows"

const TWO_ROWS: readonly AdvancedKeyRow[] = [
	{ key: "ChatBot.AutoEat.Enabled", value: "true" },
	{ key: "ChatBot.AutoFishing.Auto_Start", value: "false" },
]

describe("the add, edit, select and remove transitions", () => {
	it("appends an unselected row, which is what an operator gets from the add control", () => {
		expect(addAdvancedKeyRow(TWO_ROWS)).toEqual([...TWO_ROWS, { key: null, value: "" }])
	})

	it("rewrites only the value at the index it is given", () => {
		expect(editAdvancedKeyRow(TWO_ROWS, 1, "true")).toEqual([
			TWO_ROWS[0],
			{ key: "ChatBot.AutoFishing.Auto_Start", value: "true" },
		])
	})

	it("deletes only the row at the index it is given", () => {
		expect(removeAdvancedKeyRow(TWO_ROWS, 1)).toEqual([TWO_ROWS[0]])
	})

	it("clears the value when the key changes, so no value survives onto a key it was not entered for", () => {
		expect(selectAdvancedKeyRow(TWO_ROWS, 0, "ChatBot.AutoAttack.Mode")).toEqual([
			{ key: "ChatBot.AutoAttack.Mode", value: "" },
			TWO_ROWS[1],
		])
	})

	it("selects onto an unselected row without carrying anything into it", () => {
		const added = addAdvancedKeyRow([])

		expect(selectAdvancedKeyRow(added, 0, "ChatBot.AutoEat.Threshold")).toEqual([
			{ key: "ChatBot.AutoEat.Threshold", value: "" },
		])
	})
})

describe("the adapters between the saved object and the editor's rows", () => {
	it("sorts the rows, so the editor does not show registry order", () => {
		const rows = advancedKeyRowsFrom({
			"ChatBot.AutoAttack.Mode": "single",
			"ChatBot.AutoAttack.Enabled": "true",
		})

		expect(rows.map((row) => row.key)).toEqual([
			"ChatBot.AutoAttack.Enabled",
			"ChatBot.AutoAttack.Mode",
		])
	})

	it("round-trips a saved object through the rows and back", () => {
		const keys = {
			"ChatBot.AutoAttack.Mode": "single",
			"ChatBot.AutoAttack.Enabled": "true",
		} as const

		expect(advancedKeysFromRows(advancedKeyRowsFrom(keys))).toEqual(keys)
	})

	it("carries an edited value and omits a removed key", () => {
		const edited = editAdvancedKeyRow(TWO_ROWS, 0, "false")

		expect(advancedKeysFromRows(removeAdvancedKeyRow(edited, 1))).toEqual({
			"ChatBot.AutoEat.Enabled": "false",
		})
	})

	it("drops an unselected row rather than inventing a key for it", () => {
		expect(advancedKeysFromRows([{ key: null, value: "1.5" }])).toEqual({})
	})
})

describe("what the validation seam reports, index by index", () => {
	it("reports nothing for rows that are all valid", () => {
		expect(validateAdvancedKeyRows(TWO_ROWS)).toEqual([null, null])
	})

	it("asks for a key before it asks anything about the value", () => {
		expect(validateAdvancedKeyRows([{ key: null, value: "1.5" }])).toEqual(["Choose a key"])
	})

	it("asks both unselected rows for a key rather than calling the second a duplicate", () => {
		expect(
			validateAdvancedKeyRows([
				{ key: null, value: "" },
				{ key: null, value: "" },
			]),
		).toEqual(["Choose a key", "Choose a key"])
	})

	it("reports a duplicate on both rows that share a key", () => {
		expect(
			validateAdvancedKeyRows([
				{ key: "ChatBot.ItemsCollector.Collection_Radius", value: "1.5" },
				{ key: "ChatBot.ItemsCollector.Collection_Radius", value: "2.5" },
			]),
		).toEqual(["Duplicate key", "Duplicate key"])
	})

	it("reports a value issue only on the row that carries it", () => {
		expect(
			validateAdvancedKeyRows([
				{ key: "ChatBot.AutoEat.Enabled", value: "true" },
				{ key: "ChatBot.ItemsCollector.Collection_Radius", value: "" },
			]),
		).toEqual([null, "Decimal number"])
	})

	it.each([
		{
			named: "an integer",
			key: "ChatBot.ItemsCollector.Delay_Between_Tasks",
			says: "Whole number, no leading zeroes",
		},
		{ named: "a float", key: "ChatBot.AutoFishing.Hook_Threshold", says: "Decimal number" },
		{ named: "a boolean", key: "ChatBot.AutoEat.Enabled", says: "Must be true or false" },
		{ named: "an enum", key: "ChatBot.AutoAttack.Interaction", says: "Choose a value" },
	] as const)(
		"tells the operator what $named key wants, in words rather than zod's own",
		({ key, says }) => {
			expect(validateAdvancedKeyRows([{ key, value: "" }])).toEqual([says])
		},
	)

	it("prefers the duplicate over the value issue, so one row shows one reason", () => {
		expect(
			validateAdvancedKeyRows([
				{ key: "ChatBot.AutoEat.Enabled", value: "" },
				{ key: "ChatBot.AutoEat.Enabled", value: "" },
			]),
		).toEqual(["Duplicate key", "Duplicate key"])
	})
})

describe("the one pair of keys the client reorders behind the operator's back", () => {
	const custom = (value: string): AdvancedKeyRow => ({
		key: "ChatBot.AutoAttack.Cooldown_Time.Custom",
		value,
	})
	const min = (value: string): AdvancedKeyRow => ({
		key: "ChatBot.AutoAttack.Cooldown_Time.Min",
		value,
	})
	const max = (value: string): AdvancedKeyRow => ({
		key: "ChatBot.AutoAttack.Cooldown_Time.Max",
		value,
	})

	it("refuses a minimum above the maximum, telling each row which way it is wrong", () => {
		expect(validateAdvancedKeyRows([custom("true"), min("3.0"), max("1.0")])).toEqual([
			null,
			"Above the maximum (1)",
			"Below the minimum (3)",
		])
	})

	it("measures a lone minimum against the maximum the client would default to", () => {
		expect(validateAdvancedKeyRows([custom("true"), min("3.0")])).toEqual([
			null,
			"Above the maximum (2.5)",
		])
	})

	it("measures a lone maximum against the minimum the client would default to", () => {
		expect(validateAdvancedKeyRows([custom("true"), max("1.0")])).toEqual([
			null,
			"Below the minimum (1.5)",
		])
	})

	it("accepts a lone minimum that sits under the default maximum", () => {
		expect(validateAdvancedKeyRows([custom("true"), min("2.0")])).toEqual([null, null])
	})

	it("accepts a lone maximum that sits over the default minimum", () => {
		expect(validateAdvancedKeyRows([custom("true"), max("2.0")])).toEqual([null, null])
	})

	it("refuses a cooldown of zero, which the client would rewrite to 0.1", () => {
		expect(validateAdvancedKeyRows([custom("true"), min("0.0"), max("2.0")])).toEqual([
			null,
			"More than 0",
			null,
		])
	})

	it("accepts a minimum below the maximum", () => {
		expect(validateAdvancedKeyRows([custom("true"), min("1.0"), max("3.0")])).toEqual([
			null,
			null,
			null,
		])
	})

	it("accepts them equal, which the client leaves alone", () => {
		expect(validateAdvancedKeyRows([custom("true"), min("2.0"), max("2.0")])).toEqual([
			null,
			null,
			null,
		])
	})

	it("says nothing when the custom cooldown is off, because the client never reads them", () => {
		expect(validateAdvancedKeyRows([custom("false"), min("3.0"), max("1.0")])).toEqual([
			null,
			null,
			null,
		])
	})

	it("says nothing when the custom cooldown was never saved, because it defaults to off", () => {
		expect(validateAdvancedKeyRows([min("3.0"), max("1.0")])).toEqual([null, null])
	})

	it("leaves an unrelated row's own issue intact while reporting the pair", () => {
		expect(
			validateAdvancedKeyRows([
				custom("true"),
				min("3.0"),
				max("1.0"),
				{ key: "ChatBot.AutoEat.Threshold", value: "25" },
			]),
		).toEqual([null, "Above the maximum (1)", "Below the minimum (3)", "Between 0 and 20"])
	})
})

describe("a cooldown row whose neighbour is not even a number yet", () => {
	it("leaves the broken row's own message alone rather than replacing it with the pair's", () => {
		expect(
			validateAdvancedKeyRows([
				{ key: "ChatBot.AutoAttack.Cooldown_Time.Custom", value: "true" },
				{ key: "ChatBot.AutoAttack.Cooldown_Time.Min", value: "5.0" },
				{ key: "ChatBot.AutoAttack.Cooldown_Time.Max", value: "abc" },
			]),
		).toEqual([null, "Above the maximum (2.5)", "Decimal number"])
	})

	it("measures the good row against the client's default when its neighbour is broken", () => {
		expect(
			validateAdvancedKeyRows([
				{ key: "ChatBot.AutoAttack.Cooldown_Time.Custom", value: "true" },
				{ key: "ChatBot.AutoAttack.Cooldown_Time.Min", value: "2.0" },
				{ key: "ChatBot.AutoAttack.Cooldown_Time.Max", value: "abc" },
			]),
		).toEqual([null, null, "Decimal number"])
	})
})
