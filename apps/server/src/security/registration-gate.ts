import { REGISTRATION_CLOSED_CODE, REGISTRATION_CLOSED_MESSAGE } from "@open-mcc/contracts"
import type { Executor } from "@open-mcc/db"
import type { ValidateUserInfoResult, ValidateUserInfoSource } from "better-auth"

export type UserCreationMode = "closed" | "gated" | "trusted"

export const anyUserExists = async (db: Executor): Promise<boolean> =>
	(await db.selectFrom("user").select("id").limit(1).executeTakeFirst()) !== undefined

export const alwaysRefuses = async (): Promise<boolean> => true

export const createRegistrationGate =
	(refuses: () => Promise<boolean>) =>
	async ({
		source,
	}: {
		source: ValidateUserInfoSource
	}): Promise<ValidateUserInfoResult | undefined> => {
		if (source.action !== "create-user") return undefined
		if (!(await refuses())) return undefined
		return { error: REGISTRATION_CLOSED_CODE, errorDescription: REGISTRATION_CLOSED_MESSAGE }
	}
