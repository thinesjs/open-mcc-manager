import { OIDC_PROVIDER_ID, SIGN_IN_PATH, type SignInOptions } from "@open-mcc/contracts"
import { createFileRoute, Link, redirect, useNavigate } from "@tanstack/react-router"
import { CircleAlert } from "lucide-react"
import { type FormEvent, useState } from "react"
import { z } from "zod"
import { AffiliationNotice } from "~/components/affiliation-notice"
import { Alert } from "~/components/ui/alert"
import { Button } from "~/components/ui/button"
import { Input } from "~/components/ui/input"
import { Label } from "~/components/ui/label"
import { authClient } from "~/lib/auth-client"
import { signInFailureMessage } from "~/lib/errors"
import { decideFromSession, SIGNED_IN_LANDING } from "~/lib/session-guard"
import { trpcClient } from "~/lib/trpc"

const signInSearchSchema = z.object({ error: z.coerce.string().optional() })

export const Route = createFileRoute("/sign-in")({
	validateSearch: signInSearchSchema,
	beforeLoad: async () => {
		const session = await authClient.getSession()
		if (decideFromSession(session) === "allow") {
			throw redirect({ to: SIGNED_IN_LANDING })
		}
	},
	loader: async (): Promise<SignInOptions> => {
		try {
			return await trpcClient.system.signInOptions.query()
		} catch {
			return { singleSignOn: null, registrationOpen: false }
		}
	},
	component: SignInPage,
})

function SignInPage() {
	const navigate = useNavigate()
	const { error: failure } = Route.useSearch()
	const { singleSignOn, registrationOpen } = Route.useLoaderData()
	const [email, setEmail] = useState("")
	const [password, setPassword] = useState("")
	const [error, setError] = useState<string | null>(() =>
		singleSignOn === null || failure === undefined ? null : signInFailureMessage(failure),
	)
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

	const handleSingleSignOn = async () => {
		setError(null)
		setIsSubmitting(true)
		try {
			const started = await authClient.signIn.social({
				provider: OIDC_PROVIDER_ID,
				callbackURL: `${window.location.origin}${SIGNED_IN_LANDING}`,
				errorCallbackURL: `${window.location.origin}${SIGN_IN_PATH}`,
			})
			if (started.error) setError(signInFailureMessage(started.error.code ?? ""))
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
				{singleSignOn ? (
					<div className="space-y-4">
						<div className="flex items-center gap-3">
							<span className="h-px flex-1 bg-border" />
							<span className="text-xs text-muted-foreground">or</span>
							<span className="h-px flex-1 bg-border" />
						</div>
						<Button
							type="button"
							variant="outline"
							className="w-full"
							disabled={isSubmitting}
							onClick={handleSingleSignOn}
						>
							Continue with {singleSignOn.name}
						</Button>
					</div>
				) : null}
				{registrationOpen ? (
					<p className="text-center text-sm text-muted-foreground">
						No account exists yet.{" "}
						<Link to="/register" className="text-primary underline-offset-4 hover:underline">
							Create the first one
						</Link>
					</p>
				) : null}
				<AffiliationNotice className="text-center" />
			</div>
		</div>
	)
}
