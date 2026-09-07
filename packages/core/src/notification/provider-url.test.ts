import { describe, expect, it } from "vitest"
import { verifyProviderUrl } from "./provider-url"

const WORKFLOW =
	"https://abc123.05.environment.api.powerplatform.com/powerautomate/automations/direct/workflows/9f/triggers/manual/paths/invoke?api-version=1&sp=%2Ftriggers%2Fmanual%2Frun&sv=1.0&sig=zAbC123"

describe("refusing an address that is not the provider's own", () => {
	it("takes a Discord webhook and refuses anything else", () => {
		expect(verifyProviderUrl("discord", "https://discord.com/api/webhooks/1/aaa").allowed).toBe(
			true,
		)
		expect(verifyProviderUrl("discord", "https://discordapp.com/api/webhooks/1/aaa").allowed).toBe(
			true,
		)
		expect(verifyProviderUrl("discord", "https://ptb.discord.com/api/webhooks/1/aaa").allowed).toBe(
			true,
		)
		const wrong = verifyProviderUrl("discord", "https://evil.example.com/api/webhooks/1/aaa")
		expect(wrong.allowed).toBe(false)
		expect(wrong.allowed === false && wrong.category).toBe("host")
	})

	it("takes a Slack webhook only from where Slack issues them", () => {
		expect(verifyProviderUrl("slack", "https://hooks.slack.com/services/T/B/x").allowed).toBe(true)
		const wrong = verifyProviderUrl("slack", "https://slack.com/services/T/B/x")
		expect(wrong.allowed).toBe(false)
		expect(wrong.allowed === false && wrong.category).toBe("host")
	})

	it("takes a Power Automate workflow that anyone can call", () => {
		expect(verifyProviderUrl("teams", WORKFLOW).allowed).toBe(true)
	})

	it("refuses a workflow that would ask us to sign in, instead of failing forever later", () => {
		const noSignature = verifyProviderUrl(
			"teams",
			"https://abc123.05.environment.api.powerplatform.com/powerautomate/automations/direct/workflows/9f/triggers/manual/paths/invoke?api-version=1",
		)
		expect(noSignature.allowed).toBe(false)
		expect(noSignature.allowed === false && noSignature.category).toBe("signin")
	})

	it("names the two retired Teams addresses rather than calling them wrong", () => {
		const connector = verifyProviderUrl(
			"teams",
			"https://acme.webhook.office.com/webhookb2/aa/IncomingWebhook/bb",
		)
		expect(connector.allowed === false && connector.category).toBe("retired")
		const legacy = verifyProviderUrl(
			"teams",
			"https://prod-12.westus.logic.azure.com:443/workflows/aa/triggers/manual/paths/invoke?sig=bb",
		)
		expect(legacy.allowed === false && legacy.category).toBe("retired")
	})

	it("lets an operator name their own cloud's workflow host", () => {
		const sovereign =
			"https://abc.05.environment.api.powerplatform.us/powerautomate/automations/direct/workflows/9f/triggers/manual/paths/invoke?sig=zz"
		expect(verifyProviderUrl("teams", sovereign).allowed).toBe(false)
		expect(
			verifyProviderUrl("teams", sovereign, ["environment.api.powerplatform.us"]).allowed,
		).toBe(true)
	})

	it("refuses a query string on a self-hosted server address, which is a base we append to", () => {
		expect(verifyProviderUrl("gotify", "https://push.example.com").allowed).toBe(true)
		expect(verifyProviderUrl("gotify", "https://push.example.com/gotify").allowed).toBe(true)
		expect(verifyProviderUrl("ntfy", "https://ntfy.example.com").allowed).toBe(true)
		const withQuery = verifyProviderUrl("ntfy", "https://ntfy.example.com/?token=secret")
		expect(withQuery.allowed).toBe(false)
		expect(withQuery.allowed === false && withQuery.category).toBe("parameters")
	})

	it("has nothing to say about the kinds whose address is not a provider's", () => {
		expect(verifyProviderUrl("webhook", "https://example.com/alerts").allowed).toBe(true)
		expect(verifyProviderUrl("telegram", "").allowed).toBe(true)
		expect(verifyProviderUrl("resend", "").allowed).toBe(true)
	})

	it("refuses an address it cannot read", () => {
		const unreadable = verifyProviderUrl("discord", "not a url")
		expect(unreadable.allowed).toBe(false)
		expect(unreadable.allowed === false && unreadable.category).toBe("unreadable")
	})
})
