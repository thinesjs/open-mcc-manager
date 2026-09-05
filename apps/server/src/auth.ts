import type { Db } from "@open-mcc/db"
import { betterAuth } from "better-auth"
import { organization } from "better-auth/plugins"
import { defaultAc, ownerAc } from "better-auth/plugins/organization/access"
import { hashPassword, verifyPassword } from "./security/password"

const operatorRole = defaultAc.newRole({})
const viewerRole = defaultAc.newRole({})

export type CreateAuthOptions = {
	disableSignUp?: boolean
	disableRateLimit?: boolean
	allowOrganizationCreation?: boolean
	trustedOrigins?: readonly string[]
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
		trustedOrigins: [...(options.trustedOrigins ?? [])],
		advanced: {
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
		rateLimit: { enabled: !options.disableRateLimit, window: 60, max: 10 },
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
		],
	})

export type Auth = ReturnType<typeof createAuth>
