import { z } from "zod"
import type { Env } from "./env"

export const OIDC_DEFAULT_NAME = "single sign-on"

const OIDC_FIELDS = [
	"OIDC_ISSUER_URL",
	"OIDC_CLIENT_ID",
	"OIDC_CLIENT_SECRET",
	"OIDC_NAME",
] as const

const ENV_NAME_OF: Record<string, string | undefined> = {
	issuerUrl: "OIDC_ISSUER_URL",
	clientId: "OIDC_CLIENT_ID",
	clientSecret: "OIDC_CLIENT_SECRET",
	name: "OIDC_NAME",
}

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

const oidcConfigured = (env: Env): boolean =>
	OIDC_FIELDS.some((field) => given(env[field]) !== undefined)

const readingOf = (env: Env) =>
	providerSchema.safeParse({
		name: given(env.OIDC_NAME) ?? OIDC_DEFAULT_NAME,
		issuerUrl: given(env.OIDC_ISSUER_URL),
		clientId: given(env.OIDC_CLIENT_ID),
		clientSecret: env.OIDC_CLIENT_SECRET,
	})

export const oidcProviderFrom = (env: Env): OidcProvider | undefined => {
	const parsed = readingOf(env)
	if (!parsed.success) return undefined
	const issuerUrl = parsed.data.issuerUrl.replace(/\/+$/, "")
	return { ...parsed.data, issuerUrl, discoveryUrl: `${issuerUrl}${DISCOVERY_PATH}` }
}

export const oidcWarningFor = (env: Env): string | undefined => {
	const parsed = readingOf(env)
	if (parsed.success || !oidcConfigured(env)) return undefined
	const named = [
		...new Set(
			parsed.error.issues.flatMap((issue) => {
				const name = ENV_NAME_OF[String(issue.path[0])]
				return name === undefined ? [] : [name]
			}),
		),
	]
	return `Signing in through a provider is not offered. Check ${named.join(" and ")}.`
}
