import { useRouter } from "@tanstack/react-router"
import { type ReactNode, useState } from "react"
import { AffiliationNotice } from "~/components/affiliation-notice"
import { Button } from "~/components/ui/button"
import { Spinner } from "~/components/ui/spinner"
import { authClient } from "~/lib/auth-client"

export const InvitationNotice = ({ children }: { children: ReactNode }) => (
	<div className="flex min-h-dvh items-center justify-center bg-background p-6">
		<div className="w-full max-w-sm space-y-4 text-center">
			{children}
			<AffiliationNotice />
		</div>
	</div>
)

export const SignedInNotice = ({ email }: { email: string }) => {
	const router = useRouter()
	const [isSigningOut, setIsSigningOut] = useState(false)

	const handleSignOut = async () => {
		setIsSigningOut(true)
		try {
			await authClient.signOut()
			await router.invalidate()
		} finally {
			setIsSigningOut(false)
		}
	}

	return (
		<InvitationNotice>
			<p className="text-sm text-foreground">
				You're signed in as {email}. Sign out to accept this invitation.
			</p>
			<Button variant="outline" className="w-full" disabled={isSigningOut} onClick={handleSignOut}>
				{isSigningOut ? <Spinner label="Signing out" /> : "Sign out"}
			</Button>
		</InvitationNotice>
	)
}
