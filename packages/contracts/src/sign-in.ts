import { z } from "zod"

export const OIDC_PROVIDER_ID = "oidc"

export const SIGN_IN_PATH = "/sign-in"

export const REGISTRATION_CLOSED_CODE = "registration_closed"

export const REGISTRATION_CLOSED_MESSAGE = "Registration is closed. New members join by invitation."

export const singleSignOnSchema = z.object({ name: z.string().min(1) })

export const signInOptionsSchema = z.object({ singleSignOn: singleSignOnSchema.nullable() })

export type SignInOptions = z.infer<typeof signInOptionsSchema>
