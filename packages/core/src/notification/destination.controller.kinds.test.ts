import type { CreateDestinationInput } from "@open-mcc/contracts"
import { readDestinationConfig } from "@open-mcc/contracts/boundary/destination-config"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { SecretStore } from "../crypto/sealed-box"
import type { ActorContext } from "../host/host.controller"
import { seedMember, seedOrganization, teardownTestDb, testDb } from "../test/db"
import {
	createDestinationController,
	createDestinationControllerTransaction,
	DestinationRejectedError,
} from "./destination.controller"
import { PUBLIC_ONLY } from "./egress"
import { createNotificationRepository } from "./notification.repository"

const secrets: SecretStore = {
	activeKeyId: "key-1",
	seal: (plaintext) => ({ ciphertext: plaintext, keyId: "key-1" }),
	open: (ciphertext) => ciphertext,
}

const controller = createDestinationController({
	withTransaction: createDestinationControllerTransaction(testDb()),
	notifications: createNotificationRepository(testDb()),
	secrets,
	sendJob: async () => "job",
	policy: PUBLIC_ONLY,
	teamsHosts: ["environment.api.powerplatform.us"],
})

const WORKFLOW =
	"https://abc.05.environment.api.powerplatform.com/powerautomate/automations/direct/workflows/9f/triggers/manual/paths/invoke?api-version=1&sig=teams-signature"

const suffix = (): string => Math.random().toString(36).slice(2, 10)

let organizationId = ""
let owner: ActorContext = { organizationId: "", memberId: "", actorLabel: "", role: "owner" }

const A_DISCORD_WEBHOOK: CreateDestinationInput["destination"] = {
	kind: "discord",
	config: { url: "https://discord.com/api/webhooks/1/discord-token" },
}

const DESTINATIONS: readonly CreateDestinationInput["destination"][] = [
	A_DISCORD_WEBHOOK,
	{ kind: "slack", config: { url: "https://hooks.slack.com/services/T/B/slack-token" } },
	{ kind: "teams", config: { url: WORKFLOW } },
	{
		kind: "gotify",
		config: { serverUrl: "https://push.example.com", appToken: "gotify-token", priority: 5 },
	},
	{
		kind: "ntfy",
		config: {
			serverUrl: "https://ntfy.example.com",
			topic: "open-mcc",
			accessToken: "ntfy-token",
			priority: 3,
		},
	},
	{
		kind: "resend",
		config: {
			apiKey: "re_live_key",
			fromAddress: "alerts@example.com",
			toAddresses: ["on-call@example.com"],
		},
	},
	{
		kind: "email",
		config: {
			smtpServer: "smtp.example.com",
			smtpPort: 587,
			username: "alerts",
			password: "smtp-password",
			fromAddress: "alerts@example.com",
			toAddresses: ["on-call@example.com"],
		},
	},
]

const create = async (destination: CreateDestinationInput["destination"]) =>
	await controller.create(owner, {
		name: `${destination.kind}-${suffix()}`,
		destination,
		subscribedTo: ["instance.disconnected"],
	})

const rejection = async (destination: CreateDestinationInput["destination"]): Promise<string> => {
	try {
		await create(destination)
	} catch (error) {
		if (error instanceof DestinationRejectedError) return error.category
		throw error
	}
	throw new Error(`${destination.kind} was stored when it should have been refused`)
}

beforeAll(async () => {
	organizationId = await seedOrganization("kinds")
	const memberId = await seedMember(organizationId)
	owner = { organizationId, memberId, actorLabel: "owner", role: "owner" }
})

afterAll(async () => {
	await teardownTestDb()
})

describe("storing every kind that now has a sender", () => {
	it("stores each one, seals its settings and shows a safe target", async () => {
		for (const destination of DESTINATIONS) {
			const { destination: view, signingSecret } = await create(destination)

			expect(view.kind).toBe(destination.kind)
			expect(signingSecret).toBeUndefined()

			const row = await testDb()
				.selectFrom("notificationDestination")
				.select(["kind", "displayTarget", "secretEncrypted"])
				.where("organizationId", "=", organizationId)
				.where("id", "=", view.id)
				.executeTakeFirstOrThrow()

			expect(row.kind).toBe(destination.kind)
			expect(readDestinationConfig(row.kind, row.secretEncrypted)?.kind).toBe(destination.kind)
			for (const secret of [
				"smtp-password",
				"discord-token",
				"slack-token",
				"teams-signature",
				"gotify-token",
				"ntfy-token",
				"re_live_key",
				"on-call@example.com",
			]) {
				expect(row.displayTarget, `${destination.kind} leaked ${secret}`).not.toContain(secret)
			}
		}
	})

	it("records what kind was added, so the audit trail names it", async () => {
		const { destination: view } = await create(A_DISCORD_WEBHOOK)
		const entry = await testDb()
			.selectFrom("auditEvent")
			.select(["action", "detail"])
			.where("organizationId", "=", organizationId)
			.where("subjectId", "=", view.id)
			.executeTakeFirstOrThrow()

		expect(entry.action).toBe("notification.destination.create")
		expect(JSON.stringify(entry.detail)).toContain("discord")
	})

	it("lets an operator edit one without changing its kind", async () => {
		const { destination: view } = await create({
			kind: "gotify",
			config: { serverUrl: "https://push.example.com", appToken: "gotify-token", priority: 5 },
		})

		const edited = await controller.edit(owner, {
			destinationId: view.id,
			name: "renamed",
			destination: {
				kind: "gotify",
				config: { serverUrl: "https://other.example.com", appToken: "second-token", priority: 8 },
			},
			subscribedTo: ["instance.disconnected"],
		})

		expect(edited.name).toBe("renamed")
		expect(edited.target).toBe("https://other.example.com")
	})
})

describe("refusing an address that cannot work, instead of storing it", () => {
	it("refuses the Teams connector that Microsoft switched off", async () => {
		expect(
			await rejection({
				kind: "teams",
				config: { url: "https://acme.webhook.office.com/webhookb2/aa/IncomingWebhook/bb" },
			}),
		).toBe("retired")
	})

	it("refuses the Teams trigger endpoint that stopped working", async () => {
		expect(
			await rejection({
				kind: "teams",
				config: {
					url: "https://prod-12.westus.logic.azure.com:443/workflows/aa/triggers/manual/paths/invoke?sig=bb",
				},
			}),
		).toBe("retired")
	})

	it("refuses a workflow that would make us sign in", async () => {
		expect(
			await rejection({
				kind: "teams",
				config: {
					url: "https://abc.05.environment.api.powerplatform.com/powerautomate/automations/direct/workflows/9f/triggers/manual/paths/invoke?api-version=1",
				},
			}),
		).toBe("signin")
	})

	it("accepts a workflow on a cloud the operator named", async () => {
		const { destination: view } = await create({
			kind: "teams",
			config: {
				url: "https://abc.05.environment.api.powerplatform.us/powerautomate/automations/direct/workflows/9f/triggers/manual/paths/invoke?sig=zz",
			},
		})
		expect(view.kind).toBe("teams")
	})

	it("refuses a Discord address that is not Discord's", async () => {
		expect(
			await rejection({
				kind: "discord",
				config: { url: "https://evil.example.com/api/webhooks/1/aaa" },
			}),
		).toBe("host")
	})

	it("refuses a Slack address that Slack did not issue", async () => {
		expect(
			await rejection({ kind: "slack", config: { url: "https://slack.com/services/T/B/x" } }),
		).toBe("host")
	})

	it("refuses a server address carrying a query string", async () => {
		expect(
			await rejection({
				kind: "ntfy",
				config: {
					serverUrl: "https://ntfy.example.com/?token=secret",
					topic: "open-mcc",
					priority: 3,
				},
			}),
		).toBe("parameters")
	})

	it("refuses a mail server on this machine at save time, not at send time", async () => {
		expect(
			await rejection({
				kind: "email",
				config: {
					smtpServer: "localhost",
					smtpPort: 587,
					username: "alerts",
					password: "secret",
					fromAddress: "alerts@example.com",
					toAddresses: ["on-call@example.com"],
				},
			}),
		).toBe("loopback")
	})

	it("refuses a mail server given as a url rather than a bare address", async () => {
		expect(
			await rejection({
				kind: "email",
				config: {
					smtpServer: "smtp://smtp.example.com:587",
					smtpPort: 587,
					username: "alerts",
					password: "secret",
					fromAddress: "alerts@example.com",
					toAddresses: ["on-call@example.com"],
				},
			}),
		).toBe("parameters")
	})

	it("still refuses an address that points at the machine OpenMCC runs on", async () => {
		expect(
			await rejection({
				kind: "gotify",
				config: { serverUrl: "https://localhost", appToken: "tok", priority: 5 },
			}),
		).toBe("loopback")
	})
})
