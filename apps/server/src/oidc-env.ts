import { z } from "zod"
import type { Env } from "./env"

export const OIDC_DEFAULT_NAME = "single sign-on"

const OIDC_FIELDS = [
	"OIDC_ISSUER_URL",
	"OIDC_CLIENT_ID",
	"OIDC_CLIENT_SECRET",
	"OIDC_NAME",
] as const

const DISCOVERY_PATH = "/.well-known/openid-configuration"

export type OidcProvider = {
	name: string
	issuerUrl: string
	discoveryUrl: string
	clientId: string
	clientSecret: string
}

const providerSchema = z.object({
	name: z.string().min(1),
	issuerUrl: z.string().url(),
	clientId: z.string().min(1),
	clientSecret: z.string().refine((value) => value.trim().length > 0),
})

const given = (value: string | undefined): string | undefined => {
	const trimmed = (value ?? "").trim()
	return trimmed.length === 0 ? undefined : trimmed
}

export const oidcConfigured = (env: Env): boolean =>
	OIDC_FIELDS.some((field) => (env[field] ?? "").trim().length > 0)

export const oidcProviderFrom = (env: Env): OidcProvider | undefined => {
	const parsed = providerSchema.safeParse({
		name: given(env.OIDC_NAME) ?? OIDC_DEFAULT_NAME,
		issuerUrl: given(env.OIDC_ISSUER_URL),
		clientId: given(env.OIDC_CLIENT_ID),
		clientSecret: env.OIDC_CLIENT_SECRET,
	})
	if (!parsed.success) return undefined
	const issuerUrl = parsed.data.issuerUrl.replace(/\/+$/, "")
	return { ...parsed.data, issuerUrl, discoveryUrl: `${issuerUrl}${DISCOVERY_PATH}` }
}

export const OIDC_UNUSABLE_WARNING =
	"OIDC_* is set but does not describe a provider this deployment can sign in against, so no sign-in button is offered. Set OIDC_ISSUER_URL, OIDC_CLIENT_ID and OIDC_CLIENT_SECRET together."
