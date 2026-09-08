import { createFileRoute, Link } from "@tanstack/react-router"
import { CircleAlert, CircleCheck } from "lucide-react"
import { type FormEvent, useState } from "react"
import { z } from "zod"
import { AffiliationNotice } from "~/components/affiliation-notice"
import { Alert } from "~/components/ui/alert"
import { Button } from "~/components/ui/button"
import { Input } from "~/components/ui/input"
import { Label } from "~/components/ui/label"
import { getErrorMessage } from "~/lib/errors"
import { trpcClient } from "~/lib/trpc"

const acceptInvitationSearchSchema = z.object({
	invitation: z.string().optional(),
})

export const Route = createFileRoute("/accept-invitation")({
	validateSearch: acceptInvitationSearchSchema,
	component: AcceptInvitationPage,
})

function AcceptInvitationPage() {
	const { invitation } = Route.useSearch()
	const [invitationId, setInvitationId] = useState(invitation ?? "")
	const [name, setName] = useState("")
	const [password, setPassword] = useState("")
	const [confirmPassword, setConfirmPassword] = useState("")
	const [error, setError] = useState<string | null>(null)
	const [isSubmitting, setIsSubmitting] = useState(false)
	const [accepted, setAccepted] = useState(false)

	const handleSubmit = async (event: FormEvent) => {
		event.preventDefault()
		setError(null)

		if (password !== confirmPassword) {
			setError("Passwords do not match.")
			return
		}

		setIsSubmitting(true)
		try {
			await trpcClient.member.acceptInvitation.mutate({ invitationId, name, password })
			setAccepted(true)
		} catch (mutationError) {
			if (mutationError instanceof Error) {
				setError(getErrorMessage(mutationError))
			} else {
				setError("Something went wrong. Please try again.")
			}
		} finally {
			setIsSubmitting(false)
		}
	}

	if (accepted) {
		return (
			<div className="flex min-h-dvh items-center justify-center bg-background p-6">
				<div className="w-full max-w-sm space-y-4 text-center">
					<Alert variant="success" icon={<CircleCheck />}>
						Your account has been created. Sign in with your email and the password you just set.
					</Alert>
					<Link to="/sign-in" className="text-sm text-primary underline-offset-4 hover:underline">
						Go to sign in
					</Link>
					<AffiliationNotice />
				</div>
			</div>
		)
	}

	return (
		<div className="flex min-h-dvh items-center justify-center bg-background p-6">
			<div className="w-full max-w-sm space-y-6">
				<div className="space-y-1 text-center">
					<h1 className="text-xl font-semibold text-foreground">Accept invitation</h1>
					<p className="text-sm text-muted-foreground">
						Set your name and password to finish joining the organization.
					</p>
				</div>
				<form onSubmit={handleSubmit} className="space-y-4">
					{error ? (
						<Alert variant="error" icon={<CircleAlert />}>
							{error}
						</Alert>
					) : null}
					<div className="space-y-2">
						<Label htmlFor="invitationId">Invitation ID</Label>
						<Input
							id="invitationId"
							required
							value={invitationId}
							onChange={(event) => setInvitationId(event.target.value)}
						/>
					</div>
					<div className="space-y-2">
						<Label htmlFor="name">Name</Label>
						<Input
							id="name"
							required
							value={name}
							onChange={(event) => setName(event.target.value)}
						/>
					</div>
					<div className="space-y-2">
						<Label htmlFor="password">Password</Label>
						<Input
							id="password"
							type="password"
							autoComplete="new-password"
							required
							minLength={8}
							value={password}
							onChange={(event) => setPassword(event.target.value)}
						/>
					</div>
					<div className="space-y-2">
						<Label htmlFor="confirmPassword">Confirm password</Label>
						<Input
							id="confirmPassword"
							type="password"
							autoComplete="new-password"
							required
							minLength={8}
							value={confirmPassword}
							onChange={(event) => setConfirmPassword(event.target.value)}
						/>
					</div>
					<Button type="submit" className="w-full" disabled={isSubmitting}>
						{isSubmitting ? "Creating account…" : "Create account"}
					</Button>
				</form>
				<AffiliationNotice className="text-center" />
			</div>
		</div>
	)
}
