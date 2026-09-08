import type { Db } from "@open-mcc/db"
import { betterAuth } from "better-auth"
import { organization } from "better-auth/plugins"
import { defaultAc, ownerAc } from "better-auth/plugins/organization/access"
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

export type CreateAuthOptions = {
	disableSignUp?: boolean
	disableRateLimit?: boolean
	allowOrganizationCreation?: boolean
	trustedOrigins?: readonly string[]
	userCreation?: UserCreationMode
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
		],
	})

export type Auth = ReturnType<typeof createAuth>
