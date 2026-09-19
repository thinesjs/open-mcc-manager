import type { Role } from "@open-mcc/contracts"
import { useMutation } from "@tanstack/react-query"
import { CircleAlert } from "lucide-react"
import { type FormEvent, useState } from "react"
import { CopyButton } from "~/components/copy-button"
import { Alert } from "~/components/ui/alert"
import { Button } from "~/components/ui/button"
import { Choice } from "~/components/ui/choice"
import { Input } from "~/components/ui/input"
import { Label } from "~/components/ui/label"
import { Spinner } from "~/components/ui/spinner"
import { getErrorMessage } from "~/lib/errors"
import { invitationLink, ROLE_DESCRIPTIONS, ROLE_LABELS } from "~/lib/members"
import { useTRPC } from "~/lib/trpc"

const ROLE_OPTIONS = (["viewer", "operator", "owner"] as const).map((value) => ({
	value,
	label: ROLE_LABELS[value],
	description: ROLE_DESCRIPTIONS[value],
}))

export type InviteMemberFormProps = {
	onInvited: () => void
	onClose: () => void
}

export const InviteMemberForm = ({ onInvited, onClose }: InviteMemberFormProps) => {
	const trpc = useTRPC()
	const inviteMutation = useMutation(trpc.member.invite.mutationOptions())
	const [email, setEmail] = useState("")
	const [role, setRole] = useState<Role>("viewer")
	const [link, setLink] = useState<string | undefined>(undefined)

	const handleSubmit = (event: FormEvent) => {
		event.preventDefault()
		inviteMutation.mutate(
			{ email: email.trim(), role },
			{
				onSuccess: (invitation) => {
					setLink(invitationLink(window.location.origin, invitation.id))
					onInvited()
				},
			},
		)
	}

	if (link) {
		return (
			<div className="space-y-4">
				<p className="text-sm text-muted-foreground">
					Send this link to {email.trim()}. It works once.
				</p>
				<div className="flex items-center gap-2">
					<Input
						readOnly
						aria-label="Invitation link"
						className="min-w-0 font-mono text-xs"
						value={link}
						onFocus={(event) => event.target.select()}
					/>
					<CopyButton value={link} label="Invitation link" />
				</div>
				<div className="flex justify-end">
					<Button type="button" size="sm" onClick={onClose}>
						Done
					</Button>
				</div>
			</div>
		)
	}

	return (
		<form onSubmit={handleSubmit} className="space-y-4">
			{inviteMutation.isError ? (
				<Alert variant="error" icon={<CircleAlert />}>
					{getErrorMessage(inviteMutation.error)}
				</Alert>
			) : null}
			<div className="space-y-1.5">
				<Label htmlFor="invite-email">Email</Label>
				<Input
					id="invite-email"
					type="email"
					required
					autoFocus
					autoComplete="off"
					value={email}
					onChange={(event) => setEmail(event.target.value)}
				/>
			</div>
			<Choice label="Role" value={role} options={ROLE_OPTIONS} onChange={setRole} />
			<div className="flex justify-end gap-2">
				<Button type="button" size="sm" variant="secondary" onClick={onClose}>
					Cancel
				</Button>
				<Button type="submit" size="sm" disabled={inviteMutation.isPending}>
					{inviteMutation.isPending ? <Spinner label="Inviting" /> : "Invite"}
				</Button>
			</div>
		</form>
	)
}
