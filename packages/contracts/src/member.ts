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

export const acceptInvitationResultSchema = z.object({ accepted: z.literal(true) })

export type AcceptInvitationResult = z.infer<typeof acceptInvitationResultSchema>

export const memberSelfViewSchema = z.object({
	role: roleSchema,
})

export type MemberSelfView = z.infer<typeof memberSelfViewSchema>

export const memberIdInput = z.object({ memberId: z.string().min(1) })

export type MemberIdInput = z.infer<typeof memberIdInput>

export const invitationIdInput = z.object({ invitationId: z.string().min(1) })

export type InvitationIdInput = z.infer<typeof invitationIdInput>

export const memberViewSchema = z.object({
	id: z.string(),
	name: z.string(),
	email: z.string(),
	role: roleSchema,
	self: z.boolean(),
})

export type MemberView = z.infer<typeof memberViewSchema>

export const pendingInvitationSchema = z.object({
	id: z.string(),
	email: z.string(),
	role: roleSchema,
	expiresAt: z.date(),
})

export type PendingInvitation = z.infer<typeof pendingInvitationSchema>
