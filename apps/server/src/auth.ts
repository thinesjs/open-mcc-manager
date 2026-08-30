import type { Db } from "@open-mcc/db"
import { betterAuth } from "better-auth"
import { organization } from "better-auth/plugins"

export const createAuth = (db: Db, secret: string, baseUrl: string) =>
	betterAuth({
		secret,
		baseURL: baseUrl,
		database: { db, type: "postgres" },
		emailAndPassword: { enabled: true },
		plugins: [
			organization({
				creatorRole: "owner",
			}),
		],
	})

export type Auth = ReturnType<typeof createAuth>
