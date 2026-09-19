import { z } from "zod"

export const OIDC_PROVIDER_ID = "oidc"

export const SIGN_IN_PATH = "/sign-in"

export const REGISTRATION_CLOSED_CODE = "registration_closed"

export const REGISTRATION_CLOSED_MESSAGE = "Registration is closed. New members join by invitation."

export const singleSignOnSchema = z.object({ name: z.string().min(1) })

export type SingleSignOn = z.infer<typeof singleSignOnSchema>

export const signInOptionsSchema = z.object({
	singleSignOn: singleSignOnSchema.nullable(),
	registrationOpen: z.boolean(),
})

export type SignInOptions = z.infer<typeof signInOptionsSchema>

export const MAX_EMAIL_LENGTH = 254

export const MIN_PASSWORD_LENGTH = 8

export const MAX_PASSWORD_LENGTH = 128

export const MAX_REGISTRATION_NAME_LENGTH = 64

export const INVISIBLE_CHARACTER_IN_NAME = "Remove tabs and other invisible characters."

const withoutInvisibleCharacters = (value: string): boolean =>
	[...value].every((character) => {
		const code = character.codePointAt(0) ?? 0
		return code >= 0x20 && code !== 0x7f
	})

const registrationName = z
	.string()
	.trim()
	.min(1)
	.max(MAX_REGISTRATION_NAME_LENGTH)
	.refine(withoutInvisibleCharacters, INVISIBLE_CHARACTER_IN_NAME)

export const registerFirstOwnerInput = z.object({
	email: z.string().email().max(MAX_EMAIL_LENGTH),
	password: z.string().min(MIN_PASSWORD_LENGTH).max(MAX_PASSWORD_LENGTH),
	name: registrationName,
	organizationName: registrationName,
})

export type RegisterFirstOwnerInput = z.infer<typeof registerFirstOwnerInput>

export const registerFirstOwnerResultSchema = z.object({ registered: z.literal(true) })

export type RegisterFirstOwnerResult = z.infer<typeof registerFirstOwnerResultSchema>
