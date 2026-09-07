import { z } from "zod"
import { roleSchema } from "./authz"

export const inviteMemberInput = z.object({
	email: z.string().email(),
	role: roleSchema,
})

export type InviteMemberInput = z.infer<typeof inviteMemberInput>

export const acceptInvitationInput = z.object({
	invitationId: z.string().min(1),
	password: z.string().min(8),
	name: z.string().min(1),
})

export type AcceptInvitationInput = z.infer<typeof acceptInvitationInput>

export const memberSelfViewSchema = z.object({
	role: roleSchema,
})

export type MemberSelfView = z.infer<typeof memberSelfViewSchema>
