import { REGISTRATION_CLOSED_MESSAGE, type SignInOptions } from "@open-mcc/contracts"
import { createFileRoute, Link, redirect, useNavigate } from "@tanstack/react-router"
import { CircleAlert } from "lucide-react"
import { type FormEvent, type ReactNode, useState } from "react"
import { AffiliationNotice } from "~/components/affiliation-notice"
import { Alert } from "~/components/ui/alert"
import { Button } from "~/components/ui/button"
import { Input } from "~/components/ui/input"
import { Label } from "~/components/ui/label"
import { authClient } from "~/lib/auth-client"
import { getErrorMessage } from "~/lib/errors"
import { decideFromSession, SIGNED_IN_LANDING } from "~/lib/session-guard"
import { trpcClient } from "~/lib/trpc"

export const Route = createFileRoute("/register")({
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
	component: RegisterPage,
})

function RegisterPage() {
	const { registrationOpen } = Route.useLoaderData()
	return registrationOpen ? <RegisterForm /> : <RegistrationClosed />
}

function Centered({ children }: { children: ReactNode }) {
	return (
		<div className="flex min-h-dvh items-center justify-center bg-background p-6">
			<div className="w-full max-w-sm space-y-6">{children}</div>
		</div>
	)
}

function RegistrationClosed() {
	return (
		<Centered>
			<div className="space-y-1 text-center">
				<h1 className="text-xl font-semibold text-foreground">Register</h1>
				<p className="text-sm text-muted-foreground">{REGISTRATION_CLOSED_MESSAGE}</p>
			</div>
			<Link
				to="/sign-in"
				className="block text-center text-sm text-primary underline-offset-4 hover:underline"
			>
				Go to sign in
			</Link>
			<AffiliationNotice className="text-center" />
		</Centered>
	)
}

function RegisterForm() {
	const navigate = useNavigate()
	const [name, setName] = useState("")
	const [organizationName, setOrganizationName] = useState("")
	const [email, setEmail] = useState("")
	const [password, setPassword] = useState("")
	const [confirmPassword, setConfirmPassword] = useState("")
	const [error, setError] = useState<string | null>(null)
	const [isSubmitting, setIsSubmitting] = useState(false)

	const handleSubmit = async (event: FormEvent) => {
		event.preventDefault()
		setError(null)

		if (password !== confirmPassword) {
			setError("Passwords do not match.")
			return
		}

		setIsSubmitting(true)
		try {
			await trpcClient.member.registerFirstOwner.mutate({
				email,
				password,
				name,
				organizationName,
			})
			const signedIn = await authClient.signIn.email({ email, password })
			navigate({ to: signedIn.error ? "/sign-in" : SIGNED_IN_LANDING })
		} catch (mutationError) {
			setError(
				mutationError instanceof Error
					? getErrorMessage(mutationError)
					: "Something went wrong. Please try again.",
			)
		} finally {
			setIsSubmitting(false)
		}
	}

	return (
		<Centered>
			<div className="space-y-1 text-center">
				<h1 className="text-xl font-semibold text-foreground">Create the first account</h1>
				<p className="text-sm text-muted-foreground">
					It owns this deployment. Everyone else joins by invitation.
				</p>
			</div>
			<form onSubmit={handleSubmit} className="space-y-4">
				{error ? (
					<Alert variant="error" icon={<CircleAlert />}>
						{error}
					</Alert>
				) : null}
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
					<Label htmlFor="organizationName">Organization</Label>
					<Input
						id="organizationName"
						required
						value={organizationName}
						onChange={(event) => setOrganizationName(event.target.value)}
					/>
				</div>
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
		</Centered>
	)
}
