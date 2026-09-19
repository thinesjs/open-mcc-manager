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

export const registerFirstOwnerInput = z.object({
	email: z.string().email(),
	password: z.string().min(8),
	name: z.string().min(1),
	organizationName: z.string().min(1),
})

export type RegisterFirstOwnerInput = z.infer<typeof registerFirstOwnerInput>

export const registerFirstOwnerResultSchema = z.object({ registered: z.literal(true) })

export type RegisterFirstOwnerResult = z.infer<typeof registerFirstOwnerResultSchema>
