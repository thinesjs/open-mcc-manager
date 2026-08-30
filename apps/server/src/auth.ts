import type { Db } from "@open-mcc/db"
import { betterAuth } from "better-auth"
import { organization } from "better-auth/plugins"
import { defaultAc, ownerAc } from "better-auth/plugins/organization/access"

const operatorRole = defaultAc.newRole({})
const viewerRole = defaultAc.newRole({})

export type CreateAuthOptions = {
	disableSignUp?: boolean
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
		emailAndPassword: { enabled: true, disableSignUp: options.disableSignUp ?? true },
		plugins: [
			organization({
				creatorRole: "owner",
				roles: {
					owner: ownerAc,
					operator: operatorRole,
					viewer: viewerRole,
				},
			}),
		],
	})

export type Auth = ReturnType<typeof createAuth>
