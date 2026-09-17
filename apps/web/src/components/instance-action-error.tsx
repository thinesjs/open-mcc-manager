import { CircleAlert } from "lucide-react"
import { Alert } from "~/components/ui/alert"
import { Button } from "~/components/ui/button"
import { Spinner } from "~/components/ui/spinner"
import { errorCodeOf, getErrorMessage, type TRPCErrorLike } from "~/lib/errors"

export type InstanceActionErrorProps = {
	error: TRPCErrorLike
	busy: boolean
	cancelAuthPending: boolean
	onCancelAuth: () => void
}

export const InstanceActionError = ({
	error,
	busy,
	cancelAuthPending,
	onCancelAuth,
}: InstanceActionErrorProps) => (
	<Alert
		variant="error"
		icon={<CircleAlert />}
		action={
			errorCodeOf(error) === "INSTANCE_AUTH_IN_PROGRESS" ? (
				<Button size="sm" variant="secondary" disabled={busy} onClick={onCancelAuth}>
					{cancelAuthPending ? <Spinner label="Cancelling" /> : "Cancel sign-in"}
				</Button>
			) : undefined
		}
	>
		{getErrorMessage(error)}
	</Alert>
)
