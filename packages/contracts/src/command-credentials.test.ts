import { describe, expect, it } from "vitest"
import {
	maskCommandCredentials,
	maskUnambiguousSecrets,
	UNAMBIGUOUS_SECRET_PATTERNS,
} from "./command-credentials"

describe("a console command that carries a player's password", () => {
	it("keeps the verb and drops what follows it", () => {
		expect(maskCommandCredentials("/login hunter2")).toBe("/login [redacted]")
		expect(maskCommandCredentials("/register hunter2 hunter2")).toBe("/register [redacted]")
	})

	it("masks every alias the authentication plugin answers to", () => {
		for (const [command, expected] of [
			["/l hunter2", "/l [redacted]"],
			["/log hunter2", "/log [redacted]"],
			["/reg hunter2 hunter2", "/reg [redacted]"],
			["/unregister hunter2", "/unregister [redacted]"],
			["/unreg hunter2", "/unreg [redacted]"],
			["/changepassword hunter2 hunter3", "/changepassword [redacted]"],
			["/changepass hunter2 hunter3", "/changepass [redacted]"],
			["/cp hunter2 hunter3", "/cp [redacted]"],
		] as const) {
			expect(maskCommandCredentials(command)).toBe(expected)
		}
	})

	it("masks the two-word forms that take a password", () => {
		expect(maskCommandCredentials("/email setpassword hunter2")).toBe(
			"/email setpassword [redacted]",
		)
		expect(maskCommandCredentials("/authme register Bob hunter2")).toBe(
			"/authme register [redacted]",
		)
		expect(maskCommandCredentials("/authme password Bob hunter2")).toBe(
			"/authme password [redacted]",
		)
	})

	it("masks the subcommand aliases the admin command answers to", () => {
		for (const [command, expected] of [
			["/authme reg Bob hunter2", "/authme reg [redacted]"],
			["/authme r Bob hunter2", "/authme r [redacted]"],
			["/authme changepassword Bob hunter2", "/authme changepassword [redacted]"],
			["/authme changepass Bob hunter2", "/authme changepass [redacted]"],
			["/authme cp Bob hunter2", "/authme cp [redacted]"],
		] as const) {
			expect(maskCommandCredentials(command)).toBe(expected)
		}
	})

	it("masks it behind every prefix the console accepts", () => {
		for (const [command, expected] of [
			["login hunter2", "login [redacted]"],
			["/login hunter2", "/login [redacted]"],
			["//login hunter2", "//login [redacted]"],
			["!login hunter2", "!login [redacted]"],
		] as const) {
			expect(maskCommandCredentials(command)).toBe(expected)
		}
	})

	it("masks one typed in any case, keeping the verb as it was typed", () => {
		expect(maskCommandCredentials("/LOGIN hunter2")).toBe("/LOGIN [redacted]")
		expect(maskCommandCredentials("/Register hunter2 hunter2")).toBe("/Register [redacted]")
	})

	it("masks every line of a string that holds more than one", () => {
		const masked = maskCommandCredentials("/say hello\n/login hunter2")
		expect(masked).toBe("/say hello\n/login [redacted]")
		expect(masked).not.toContain("hunter2")
	})

	it("masks a line a separator no contract rejects has started", () => {
		const masked = maskCommandCredentials("/say hello\u2028/login hunter2")
		expect(masked).toBe("/say hello\u2028/login [redacted]")
		expect(masked).not.toContain("hunter2")
	})

	it("leaves an ordinary command alone", () => {
		for (const command of [
			"/say hello everyone",
			"/tp 100 64 -200",
			"/gamemode creative",
			"/give @p minecraft:stone 64",
			"/logout",
			"/list",
		]) {
			expect(maskCommandCredentials(command)).toBe(command)
		}
	})

	it("leaves a credential word that is not the command alone", () => {
		for (const command of [
			"/tell Bob l o l",
			"/say the reg is open",
			"/msg Bob login later",
			"/say cp is down",
		]) {
			expect(maskCommandCredentials(command)).toBe(command)
		}
	})

	it("leaves a credential verb with nothing after it alone", () => {
		expect(maskCommandCredentials("/login")).toBe("/login")
	})
})

describe("a secret pasted into a command", () => {
	it("is recognised behind every marker the browser can trust", () => {
		const cases: ReadonlyArray<readonly [string, string]> = [
			[
				"/paste -----BEGIN OPENSSH PRIVATE KEY-----\nsecret\n-----END OPENSSH PRIVATE KEY-----",
				"/paste [redacted private key]",
			],
			["/env SEALBOX_KEYS=k1:AAAABBBBCCCC=", "/env SEALBOX_KEYS=[redacted]"],
			["/sign whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw=", "/sign [redacted secret]"],
			[
				"/notify https://api.telegram.org/bot123456789:AAF-abcdefghijklmnopqrstuvwxyz012345/sendMessage",
				"/notify https://api.telegram.org/bot[redacted]/sendMessage",
			],
			[
				"/notify https://hooks.slack.com/services/T000/B000/XXXXXXXX",
				"/notify https://hooks.slack.com/services/[redacted]",
			],
			[
				"/notify https://ptb.discord.com/api/webhooks/123/abcdef",
				"/notify https://ptb.discord.com/api/webhooks/[redacted]",
			],
			[
				"/notify https://acme.webhook.office.com/webhookb2/aa/IncomingWebhook/bb",
				"/notify https://acme.webhook.office.com/webhookb2/[redacted]",
			],
			[
				"/notify https://abc.05.environment.api.powerplatform.com/powerautomate/x?sig=zAbC123",
				"/notify https://abc.05.environment.api.powerplatform.com/[redacted]",
			],
			[
				"/notify https://prod-12.westus.logic.azure.com:443/workflows/aa/triggers/manual",
				"/notify https://prod-12.westus.logic.azure.com:443/workflows/[redacted]",
			],
			[
				"/fetch /invoke?api-version=1&sp=%2Frun&sv=1.0&sig=zAbC123",
				"/fetch /invoke?api-version=1&sp=[redacted]&sv=[redacted]&sig=[redacted]",
			],
			["/header X-Gotify-Key: A1b2C3d4E5", "/header X-Gotify-Key: [redacted]"],
			["/mail re_abcdefghij0123456789", "/mail re_[redacted]"],
		]

		for (const [command, expected] of cases) {
			expect(maskUnambiguousSecrets(command)).toBe(expected)
		}
	})

	it("carries one pattern per marker, with none left over", () => {
		expect(Object.keys(UNAMBIGUOUS_SECRET_PATTERNS)).toHaveLength(12)
	})
})

describe("an ordinary Minecraft command", () => {
	it("survives every pattern the browser applies, so Recent keeps it", () => {
		for (const command of [
			"/team join BLUE-TEAM",
			"/warp NETHER-HUB",
			"/say bearer of bad news",
			"/say AUTH PLAIN text please",
			"/say enter code ABCD-EFGH",
			"/say check https://example.com/page?id=5",
			"/say sig figs matter",
			"/say ?sp is a weird acronym",
			"/say pre_release build is up",
			"/say i re_joined the game",
			"/give @p minecraft:stone 64",
			"/w Steve meet me at 123:456",
			"/tp @p 100 64 -200",
			"/say server ip is play.example.com:25565",
			"/say my discord is discord.com/users/1234",
		]) {
			expect(maskUnambiguousSecrets(command)).toBe(command)
		}
	})
})
