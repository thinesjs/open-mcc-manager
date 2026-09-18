import { describe, expect, it } from "vitest"
import type { Env } from "./env"
import { OIDC_DEFAULT_NAME, oidcConfigured, oidcProviderFrom } from "./oidc-env"

const BASE: Env = {
	DATABASE_URL: "postgres://nobody:nobody@127.0.0.1:1/nope",
	PORT: 3000,
	STATUS_RETENTION_DAYS: 30,
	BETTER_AUTH_SECRET: "a-very-long-test-secret-value-000000",
	BETTER_AUTH_URL: "http://localhost:3000",
	SEALBOX_KEYS: "k1:aaa:bbb",
	ALLOWED_ORIGINS: "http://localhost:5173",
	NOTIFICATION_ALLOW_HTTP: false,
	NOTIFICATION_ALLOWED_HOSTS: "",
	NOTIFICATION_ALLOWED_ADDRESSES: "",
	NOTIFICATION_TEAMS_HOSTS: "",
	OTEL_EXPORTER_OTLP_ENDPOINT: "",
}

const CONFIGURED: Env = {
	...BASE,
	OIDC_ISSUER_URL: "https://id.example.com/application/o/open-mcc",
	OIDC_CLIENT_ID: "open-mcc-manager",
	OIDC_CLIENT_SECRET: "a-client-secret",
	OIDC_NAME: "Acme ID",
}

describe("reading the provider an operator configured", () => {
	it("offers none at all when nothing is set", () => {
		expect(oidcConfigured(BASE)).toBe(false)
		expect(oidcProviderFrom(BASE)).toBeUndefined()
	})

	it("treats the empty values a compose file always passes as nothing set", () => {
		const blank = {
			...BASE,
			OIDC_ISSUER_URL: "",
			OIDC_CLIENT_ID: "",
			OIDC_CLIENT_SECRET: "",
			OIDC_NAME: "",
		}

		expect(oidcConfigured(blank)).toBe(false)
		expect(oidcProviderFrom(blank)).toBeUndefined()
	})

	it("derives the discovery document from the issuer the operator named", () => {
		expect(oidcProviderFrom(CONFIGURED)).toEqual({
			name: "Acme ID",
			issuerUrl: "https://id.example.com/application/o/open-mcc",
			discoveryUrl:
				"https://id.example.com/application/o/open-mcc/.well-known/openid-configuration",
			clientId: "open-mcc-manager",
			clientSecret: "a-client-secret",
		})
	})

	it("reads a trailing slash on the issuer as the same provider, not a second one", () => {
		const slashed = { ...CONFIGURED, OIDC_ISSUER_URL: `${CONFIGURED.OIDC_ISSUER_URL ?? ""}/` }

		expect(oidcProviderFrom(slashed)).toEqual(oidcProviderFrom(CONFIGURED))
	})

	it("falls back to a name the button can carry when the operator gave none", () => {
		const unnamed = { ...CONFIGURED, OIDC_NAME: undefined }

		expect(oidcProviderFrom(unnamed)?.name).toBe(OIDC_DEFAULT_NAME)
	})

	it.each(["OIDC_ISSUER_URL", "OIDC_CLIENT_ID", "OIDC_CLIENT_SECRET"] as const)(
		"offers no provider, and still reads as configured, when %s alone is missing",
		(missing) => {
			const partial = { ...CONFIGURED, [missing]: undefined }

			expect(oidcConfigured(partial)).toBe(true)
			expect(oidcProviderFrom(partial)).toBeUndefined()
		},
	)

	it("refuses an issuer that is not a URL, so no half-built discovery address is fetched", () => {
		const typo = { ...CONFIGURED, OIDC_ISSUER_URL: "id.example.com" }

		expect(oidcConfigured(typo)).toBe(true)
		expect(oidcProviderFrom(typo)).toBeUndefined()
	})

	it("refuses a secret that is only whitespace rather than sending it to a token endpoint", () => {
		const blank = { ...CONFIGURED, OIDC_CLIENT_SECRET: "   " }

		expect(oidcProviderFrom(blank)).toBeUndefined()
	})

	it("hands the secret on exactly as the operator set it", () => {
		const padded = { ...CONFIGURED, OIDC_CLIENT_SECRET: " keeps its edges " }

		expect(oidcProviderFrom(padded)?.clientSecret).toBe(" keeps its edges ")
	})
})
