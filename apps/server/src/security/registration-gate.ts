import type { Executor } from "@open-mcc/db"
import type { ValidateUserInfoResult, ValidateUserInfoSource } from "better-auth"

export type UserCreationMode = "gated" | "trusted"

export const REGISTRATION_CLOSED_CODE = "registration_closed"

export const REGISTRATION_CLOSED_MESSAGE = "Registration is closed. New members join by invitation."

export const anyUserExists = async (db: Executor): Promise<boolean> =>
	(await db.selectFrom("user").select("id").limit(1).executeTakeFirst()) !== undefined

export const createRegistrationGate =
	(userExists: () => Promise<boolean>) =>
	async ({
		source,
	}: {
		source: ValidateUserInfoSource
	}): Promise<ValidateUserInfoResult | undefined> => {
		if (source.action !== "create-user") return undefined
		if (!(await userExists())) return undefined
		return { error: REGISTRATION_CLOSED_CODE, errorDescription: REGISTRATION_CLOSED_MESSAGE }
	}
