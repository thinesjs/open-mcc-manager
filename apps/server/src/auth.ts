import { OIDC_PROVIDER_ID } from "@open-mcc/contracts"
import type { Db } from "@open-mcc/db"
import { betterAuth } from "better-auth"
import { organization } from "better-auth/plugins"
import { genericOAuth } from "better-auth/plugins/generic-oauth"
import { defaultAc, ownerAc } from "better-auth/plugins/organization/access"
import type { OidcProvider } from "./oidc-env"
import { hashPassword, verifyPassword } from "./security/password"
import {
	anyUserExists,
	createRegistrationGate,
	type UserCreationMode,
} from "./security/registration-gate"

const operatorRole = defaultAc.newRole({})
const viewerRole = defaultAc.newRole({})

const GATES_USER_CREATION: Record<UserCreationMode, boolean> = { gated: true, trusted: false }

const registrationGateFor = (mode: UserCreationMode, db: Db) =>
	GATES_USER_CREATION[mode]
		? { validateUserInfo: createRegistrationGate(() => anyUserExists(db)) }
		: undefined

const OIDC_SCOPES = ["openid", "email", "profile"]

const oidcPluginsFor = (oidc: OidcProvider | undefined) =>
	oidc === undefined
		? []
		: [
				genericOAuth({
					config: [
						{
							providerId: OIDC_PROVIDER_ID,
							name: oidc.name,
							clientId: oidc.clientId,
							clientSecret: oidc.clientSecret,
							discoveryUrl: oidc.discoveryUrl,
							accountIssuer: oidc.issuerUrl,
							scopes: OIDC_SCOPES,
						},
					],
				}),
			]

const accountFor = (oidc: OidcProvider | undefined) =>
	oidc === undefined ? undefined : { accountLinking: { requireLocalEmailVerified: false } }

export type CreateAuthOptions = {
	disableSignUp?: boolean
	disableRateLimit?: boolean
	allowOrganizationCreation?: boolean
	trustedOrigins?: readonly string[]
	userCreation?: UserCreationMode
	oidc?: OidcProvider | undefined
}

export const createAuth = (
	db: Db,
	secret: string,
	baseUrl: string,
	options: CreateAuthOptions = {},
) =>
	betterAuth({
		secret,
		baseURL: baseUrl,
		database: { db, type: "postgres" },
		emailAndPassword: {
			enabled: true,
			disableSignUp: options.disableSignUp ?? true,
			password: {
				hash: hashPassword,
				verify: ({ hash, password }) => verifyPassword(hash, password),
			},
		},
		user: registrationGateFor(options.userCreation ?? "gated", db),
		account: accountFor(options.oidc),
		trustedOrigins: [...(options.trustedOrigins ?? [])],
		advanced: {
			ipAddress: {
				ipAddressHeaders: ["x-forwarded-for", "x-real-ip"],
			},
			disableOriginCheck: false,
			useSecureCookies: true,
			cookiePrefix: "__Host-",
			defaultCookieAttributes: {
				httpOnly: true,
				secure: true,
				sameSite: "lax",
				path: "/",
			},
		},
		rateLimit: {
			enabled: !options.disableRateLimit,
			window: 60,
			max: 10,
			customRules: {
				"/get-session": { window: 60, max: 600 },
			},
		},
		databaseHooks: {
			session: {
				create: {
					before: async (session) => {
						const membership = await db
							.selectFrom("member")
							.select("organizationId")
							.where("userId", "=", session.userId)
							.orderBy("createdAt", "asc")
							.executeTakeFirst()
						if (!membership) return
						return { data: { ...session, activeOrganizationId: membership.organizationId } }
					},
				},
			},
		},
		plugins: [
			organization({
				creatorRole: "owner",
				allowUserToCreateOrganization: options.allowOrganizationCreation ?? false,
				roles: {
					owner: ownerAc,
					operator: operatorRole,
					viewer: viewerRole,
				},
			}),
			...oidcPluginsFor(options.oidc),
		],
	})

export type Auth = ReturnType<typeof createAuth>
