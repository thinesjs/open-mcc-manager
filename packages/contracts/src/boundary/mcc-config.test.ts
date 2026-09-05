import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
	McConfigUnparseableError,
	parseMccConfig,
	readMccConfigKeys,
	readMccConfigSections,
} from "./mcc-config"

const realConfig = readFileSync(join(__dirname, "mcc-config-fixture.ini"), "utf8")

describe("reading a client config", () => {
	it("reads a config the client itself wrote, in full", () => {
		expect(() => parseMccConfig(realConfig)).not.toThrow()
	})

	it("reads an integer too large for a double, which the client's own defaults contain", () => {
		const reading = readMccConfigKeys(realConfig, ["ChatBot.DiscordBridge.GuildId"])

		expect(reading.unreadable).toEqual(["ChatBot.DiscordBridge.GuildId"])
	})

	it("sees a sub-table and an inline table as the same key", () => {
		const asSubTable = readMccConfigKeys('[Main.General.Account]\nLogin = "Steve"\n', [
			"Main.General.Account.Login",
		])
		const asInline = readMccConfigKeys('[Main.General]\nAccount = { Login = "Steve" }\n', [
			"Main.General.Account.Login",
		])

		expect(asSubTable.values.get("Main.General.Account.Login")).toBe("Steve")
		expect(asInline.values.get("Main.General.Account.Login")).toBe("Steve")
	})

	it("reads the account the real config carries", () => {
		const reading = readMccConfigKeys(realConfig, [
			"Main.General.Account.Login",
			"Main.General.Account.Password",
			"Main.General.AccountType",
			"Main.Advanced.InternalCmdChar",
		])

		expect(reading.values.get("Main.General.Account.Login")).toBe("OpenMccBot")
		expect(reading.values.get("Main.General.Account.Password")).toBe("-")
		expect(reading.values.get("Main.General.AccountType")).toBe("microsoft")
		expect(reading.values.get("Main.Advanced.InternalCmdChar")).toBe("slash")
	})

	it("reads a quoted key containing a space", () => {
		const reading = readMccConfigKeys(realConfig, ["Head.Current Version"])

		expect(reading.values.get("Head.Current Version")).toContain("GitHub build")
	})

	it("collapses a min-max pair the client writes for a delay into one number", () => {
		const reading = readMccConfigKeys(realConfig, [
			"ChatBot.AutoRelog.Delay",
			"ChatBot.AntiAFK.Delay",
		])

		expect(reading.values.get("ChatBot.AutoRelog.Delay")).toBe(10)
		expect(reading.values.get("ChatBot.AntiAFK.Delay")).toBe(60)
	})

	it("refuses to collapse a range whose ends differ", () => {
		const reading = readMccConfigKeys("[ChatBot.AutoRelog]\nDelay = { min = 1.0, max = 9.0 }\n", [
			"ChatBot.AutoRelog.Delay",
		])

		expect(reading.values.has("ChatBot.AutoRelog.Delay")).toBe(false)
		expect(reading.unreadable).toEqual(["ChatBot.AutoRelog.Delay"])
	})

	it("omits a key the file does not carry rather than inventing one", () => {
		const reading = readMccConfigKeys(realConfig, ["Main.Advanced.NoSuchKey"])

		expect(reading.values.size).toBe(0)
		expect(reading.unreadable).toEqual([])
	})

	it("reports how many entries a section holds, so an emptied one can be checked", () => {
		const sizes = readMccConfigSections(realConfig, ["Main.Advanced.AccountList"])

		expect(sizes.get("Main.Advanced.AccountList")).toBe(2)
	})

	it("sees an emptied section as empty", () => {
		const sizes = readMccConfigSections("[Main.Advanced.AccountList]\n", [
			"Main.Advanced.AccountList",
		])

		expect(sizes.get("Main.Advanced.AccountList")).toBe(0)
	})

	it("names the file rather than throwing something opaque when it cannot be read", () => {
		expect(() => parseMccConfig("this is = = not toml")).toThrow(McConfigUnparseableError)
	})
})
