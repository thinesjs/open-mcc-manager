import { describe, expect, it } from "vitest"
import { redact, redactCommand } from "./redact"

describe("redact", () => {
	it("masks a bearer token", () => {
		expect(redact("Authorization: Bearer abc123def456")).not.toContain("abc123def456")
	})

	it("masks an ssh private key block", () => {
		const key = "-----BEGIN OPENSSH PRIVATE KEY-----\nsecret\n-----END OPENSSH PRIVATE KEY-----"
		expect(redact(key)).not.toContain("secret")
	})

	it("masks a device user code", () => {
		expect(redact("enter code ABCD-EFGH to continue")).not.toContain("ABCD-EFGH")
	})

	it("leaves ordinary text alone", () => {
		expect(redact("connected to server")).toBe("connected to server")
	})
})

describe("secrets a connector could leak into a log line", () => {
	it("hides a signing secret", () => {
		expect(redact("using whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw= to sign")).toBe(
			"using [redacted secret] to sign",
		)
	})

	it("hides a Telegram bot token, in a url or on its own", () => {
		expect(
			redact(
				"POST https://api.telegram.org/bot123456789:AAF-abcdefghijklmnopqrstuvwxyz012345/sendMessage",
			),
		).toBe("POST https://api.telegram.org/bot[redacted]/sendMessage")
		expect(redact("token=123456789:AAF-abcdefghijklmnopqrstuvwxyz012345")).toBe(
			"token=[redacted token]",
		)
	})

	it("hides the part of an incoming webhook url that is the password", () => {
		expect(redact("https://hooks.slack.com/services/T000/B000/XXXXXXXX")).toBe(
			"https://hooks.slack.com/services/[redacted]",
		)
		expect(redact("https://discord.com/api/webhooks/123/abcdef")).toBe(
			"https://discord.com/api/webhooks/[redacted]",
		)
		expect(redact("https://acme.webhook.office.com/webhookb2/abc/IncomingWebhook/def")).toBe(
			"https://acme.webhook.office.com/webhookb2/[redacted]",
		)
	})

	it("hides a Resend key", () => {
		expect(redact("apiKey re_abcdefghij0123456789")).toBe("apiKey re_[redacted]")
	})

	it("leaves ordinary words that merely contain re_ alone", () => {
		for (const text of [
			"feature_re_engineering",
			"the re_run finished",
			"pre_release_candidate_build",
		]) {
			expect(redact(text)).toBe(text)
		}
	})

	it("hides a Gotify application token", () => {
		expect(redact("X-Gotify-Key: A1b2C3d4E5")).toBe("X-Gotify-Key: [redacted]")
		expect(redact("x-gotify-key=A1b2C3d4E5")).toBe("x-gotify-key=[redacted]")
	})

	it("hides the signature that lets anyone call a Teams workflow", () => {
		const workflow =
			"https://abc.05.environment.api.powerplatform.com/powerautomate/automations/direct/workflows/9f/triggers/manual/paths/invoke?api-version=1&sig=zAbC123"
		const masked = redact(workflow)
		expect(masked).toBe("https://abc.05.environment.api.powerplatform.com/[redacted]")
		expect(masked).not.toContain("zAbC123")
	})

	it("hides a workflow signature on a cloud whose host it does not know", () => {
		const masked = redact("GET /invoke?api-version=1&sp=%2Frun&sv=1.0&sig=zAbC123 failed")
		expect(masked).not.toContain("zAbC123")
		expect(masked).toContain("sig=[redacted]")
	})

	it("hides the retired Teams addresses, which an operator may still have stored", () => {
		expect(redact("https://acme.webhook.office.com/webhookb2/aa/IncomingWebhook/bb/cc")).toBe(
			"https://acme.webhook.office.com/webhookb2/[redacted]",
		)
		expect(redact("https://prod-12.westus.logic.azure.com:443/workflows/aa/triggers/manual")).toBe(
			"https://prod-12.westus.logic.azure.com:443/workflows/[redacted]",
		)
	})

	it("hides a Discord webhook on any of its hosts", () => {
		expect(redact("https://ptb.discord.com/api/webhooks/1/tok")).toBe(
			"https://ptb.discord.com/api/webhooks/[redacted]",
		)
		expect(redact("https://discord.com/api/webhooks/1/tok")).toBe(
			"https://discord.com/api/webhooks/[redacted]",
		)
	})

	it("leaves an ordinary address alone", () => {
		expect(redact("https://hooks.example.com/notify")).toBe("https://hooks.example.com/notify")
	})
})

describe("a console command that carries a player's password", () => {
	it("keeps the verb and drops what follows it", () => {
		expect(redactCommand("/login hunter2")).toBe("/login [redacted]")
		expect(redactCommand("/register hunter2 hunter2")).toBe("/register [redacted]")
	})

	it("masks the aliases and the other credential verbs", () => {
		for (const [command, expected] of [
			["/l hunter2", "/l [redacted]"],
			["/reg hunter2 hunter2", "/reg [redacted]"],
			["/changepassword hunter2 hunter3", "/changepassword [redacted]"],
			["/changepass hunter2 hunter3", "/changepass [redacted]"],
			["/unregister hunter2", "/unregister [redacted]"],
		] as const) {
			expect(redactCommand(command)).toBe(expected)
		}
	})

	it("masks one typed without the leading slash", () => {
		expect(redactCommand("login hunter2")).toBe("login [redacted]")
	})

	it("masks one typed in any case, keeping the verb as it was typed", () => {
		expect(redactCommand("/LOGIN hunter2")).toBe("/LOGIN [redacted]")
		expect(redactCommand("/Register hunter2 hunter2")).toBe("/Register [redacted]")
	})

	it("masks every line of a command that spans more than one", () => {
		const masked = redactCommand("/say hello\n/login hunter2")
		expect(masked).toBe("/say hello\n/login [redacted]")
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
			expect(redactCommand(command)).toBe(command)
		}
	})

	it("leaves a credential verb with nothing after it alone", () => {
		expect(redactCommand("/login")).toBe("/login")
	})
})
