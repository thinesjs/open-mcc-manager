import { can, type MemberView, type Role } from "@open-mcc/contracts"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { CircleAlert, UserMinus, UserPlus, X } from "lucide-react"
import { useState } from "react"
import { CopyButton } from "~/components/copy-button"
import { InviteMemberForm } from "~/components/invite-member-form"
import { Alert } from "~/components/ui/alert"
import { Badge } from "~/components/ui/badge"
import { Button } from "~/components/ui/button"
import { ConfirmDialog } from "~/components/ui/dialog"
import { Modal } from "~/components/ui/modal"
import { LoadingBlock, Spinner } from "~/components/ui/spinner"
import { Tooltip } from "~/components/ui/tooltip"
import { getErrorMessage } from "~/lib/errors"
import { hasExpired, invitationLink, ROLE_DESCRIPTIONS, ROLE_LABELS } from "~/lib/members"
import { useTRPC } from "~/lib/trpc"

const ROW_LIST =
	"divide-y divide-border overflow-hidden rounded-[var(--radius)] border border-border bg-card"

const RoleLabel = ({ role }: { role: Role }) => (
	<span className="shrink-0 text-xs text-muted-foreground">
		<Tooltip content={ROLE_DESCRIPTIONS[role]}>{ROLE_LABELS[role]}</Tooltip>
	</span>
)

export type MembersPanelProps = {
	role: Role
}

export const MembersPanel = ({ role }: MembersPanelProps) => {
	const trpc = useTRPC()
	const queryClient = useQueryClient()
	const mayManage = can(role, "member.manage")
	const membersQuery = useQuery({ ...trpc.member.list.queryOptions(), enabled: mayManage })
	const invitationsQuery = useQuery({
		...trpc.member.invitations.queryOptions(),
		enabled: mayManage,
	})
	const removeMutation = useMutation(trpc.member.remove.mutationOptions())
	const cancelMutation = useMutation(trpc.member.cancelInvitation.mutationOptions())
	const [inviting, setInviting] = useState(false)
	const [pendingRemoval, setPendingRemoval] = useState<MemberView | undefined>(undefined)

	const refreshInvitations = () => {
		queryClient.invalidateQueries({ queryKey: trpc.member.invitations.queryKey() })
	}

	const handleRemove = () => {
		if (!pendingRemoval) return
		removeMutation.mutate(
			{ memberId: pendingRemoval.id },
			{
				onSuccess: () => {
					setPendingRemoval(undefined)
					queryClient.invalidateQueries({ queryKey: trpc.member.list.queryKey() })
					refreshInvitations()
				},
			},
		)
	}

	const header = (
		<div className="flex items-start justify-between gap-4">
			<div>
				<h1 className="text-lg font-semibold text-foreground">Members</h1>
				<p className="text-sm text-muted-foreground">
					People who can sign in to this organization.
				</p>
			</div>
			{mayManage ? (
				<Button size="sm" onClick={() => setInviting(true)}>
					<UserPlus className="size-4" />
					Invite
				</Button>
			) : null}
		</div>
	)

	if (!mayManage) {
		return (
			<div className="space-y-6">
				{header}
				<p className="text-sm text-muted-foreground">Only owners can manage members.</p>
			</div>
		)
	}

	const now = Date.now()
	const invitations = invitationsQuery.data ?? []

	return (
		<div className="space-y-6">
			{header}

			{membersQuery.isPending ? <LoadingBlock label="Loading members" /> : null}

			{membersQuery.isError ? (
				<Alert variant="error" icon={<CircleAlert />}>
					{getErrorMessage(membersQuery.error)}
				</Alert>
			) : null}

			{cancelMutation.isError ? (
				<Alert variant="error" icon={<CircleAlert />}>
					{getErrorMessage(cancelMutation.error)}
				</Alert>
			) : null}

			{membersQuery.data ? (
				<div className={ROW_LIST}>
					{membersQuery.data.map((member) => (
						<div key={member.id} className="flex items-center gap-3 px-4 py-3">
							<div className="min-w-0 flex-1">
								<p className="truncate font-medium text-foreground">{member.name}</p>
								<p className="truncate text-xs text-muted-foreground">{member.email}</p>
							</div>
							{member.self ? <Badge variant="secondary">You</Badge> : null}
							<RoleLabel role={member.role} />
							{member.self ? null : (
								<Button
									type="button"
									variant="destructive-outline"
									size="icon"
									aria-label={`Remove ${member.name}`}
									disabled={removeMutation.isPending}
									onClick={() => setPendingRemoval(member)}
								>
									{removeMutation.isPending && removeMutation.variables?.memberId === member.id ? (
										<Spinner label="Removing" />
									) : (
										<UserMinus />
									)}
								</Button>
							)}
						</div>
					))}
				</div>
			) : null}

			{invitations.length > 0 ? (
				<section className="space-y-2">
					<h2 className="text-sm font-medium text-foreground">Invited</h2>
					<div className={ROW_LIST}>
						{invitations.map((invitation) => {
							const expired = hasExpired(invitation.expiresAt, now)
							return (
								<div key={invitation.id} className="flex items-center gap-3 px-4 py-3">
									<div className="min-w-0 flex-1">
										<p className="truncate font-medium text-foreground">{invitation.email}</p>
										<p className="truncate text-xs text-muted-foreground">
											{ROLE_LABELS[invitation.role]}
										</p>
									</div>
									{expired ? (
										<Badge variant="warning">Expired</Badge>
									) : (
										<CopyButton
											value={invitationLink(window.location.origin, invitation.id)}
											label="Invitation link"
										/>
									)}
									<Button
										type="button"
										variant="outline"
										size="icon"
										aria-label={`Cancel invitation for ${invitation.email}`}
										disabled={cancelMutation.isPending}
										onClick={() =>
											cancelMutation.mutate(
												{ invitationId: invitation.id },
												{ onSuccess: refreshInvitations },
											)
										}
									>
										{cancelMutation.isPending &&
										cancelMutation.variables?.invitationId === invitation.id ? (
											<Spinner label="Cancelling" />
										) : (
											<X />
										)}
									</Button>
								</div>
							)
						})}
					</div>
				</section>
			) : null}

			<Modal
				open={inviting}
				title="Invite member"
				description="They get a link to set a password and join."
				onClose={() => setInviting(false)}
			>
				<InviteMemberForm onInvited={refreshInvitations} onClose={() => setInviting(false)} />
			</Modal>

			<ConfirmDialog
				open={pendingRemoval !== undefined}
				title="Remove member"
				description={`${pendingRemoval?.name ?? "This member"} loses access and is signed out right away. What they set up stays.`}
				confirmLabel="Remove"
				destructive
				busy={removeMutation.isPending}
				error={removeMutation.isError ? getErrorMessage(removeMutation.error) : undefined}
				onConfirm={handleRemove}
				onCancel={() => setPendingRemoval(undefined)}
			/>
		</div>
	)
}
