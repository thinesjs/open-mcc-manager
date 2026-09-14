import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router"
import { CircleAlert } from "lucide-react"
import { type FormEvent, useState } from "react"
import { AffiliationNotice } from "~/components/affiliation-notice"
import { Alert } from "~/components/ui/alert"
import { Button } from "~/components/ui/button"
import { Input } from "~/components/ui/input"
import { Label } from "~/components/ui/label"
import { authClient } from "~/lib/auth-client"
import { decideFromSession, SIGNED_IN_LANDING } from "~/lib/session-guard"

export const Route = createFileRoute("/sign-in")({
	beforeLoad: async () => {
		const session = await authClient.getSession()
		if (decideFromSession(session) === "allow") {
			throw redirect({ to: SIGNED_IN_LANDING })
		}
	},
	component: SignInPage,
})

function SignInPage() {
	const navigate = useNavigate()
	const [email, setEmail] = useState("")
	const [password, setPassword] = useState("")
	const [error, setError] = useState<string | null>(null)
	const [isSubmitting, setIsSubmitting] = useState(false)

	const handleSubmit = async (event: FormEvent) => {
		event.preventDefault()
		setError(null)
		setIsSubmitting(true)
		try {
			const signInResult = await authClient.signIn.email({ email, password })
			if (signInResult.error) {
				setError(signInResult.error.message ?? "Invalid email or password.")
				return
			}

			const organizations = await authClient.organization.list()
			const firstOrganization = organizations.data?.at(0)
			if (!firstOrganization) {
				setError("Your account is not a member of any organization.")
				return
			}

			await authClient.organization.setActive({ organizationId: firstOrganization.id })
			navigate({ to: SIGNED_IN_LANDING })
		} finally {
			setIsSubmitting(false)
		}
	}

	return (
		<div className="flex min-h-dvh items-center justify-center bg-background p-6">
			<div className="w-full max-w-sm space-y-6">
				<div className="space-y-1 text-center">
					<h1 className="text-xl font-semibold text-foreground">Sign in</h1>
					<p className="text-sm text-muted-foreground">open-mcc-manager control plane</p>
				</div>
				<form onSubmit={handleSubmit} className="space-y-4">
					{error ? (
						<Alert variant="error" icon={<CircleAlert />}>
							{error}
						</Alert>
					) : null}
					<div className="space-y-2">
						<Label htmlFor="email">Email</Label>
						<Input
							id="email"
							type="email"
							autoComplete="email"
							required
							value={email}
							onChange={(event) => setEmail(event.target.value)}
						/>
					</div>
					<div className="space-y-2">
						<Label htmlFor="password">Password</Label>
						<Input
							id="password"
							type="password"
							autoComplete="current-password"
							required
							value={password}
							onChange={(event) => setPassword(event.target.value)}
						/>
					</div>
					<Button type="submit" className="w-full" disabled={isSubmitting}>
						{isSubmitting ? "Signing in…" : "Sign in"}
					</Button>
				</form>
				<AffiliationNotice className="text-center" />
			</div>
		</div>
	)
}
