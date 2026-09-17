import { can } from "@open-mcc/contracts"
import { useMutation, useQuery } from "@tanstack/react-query"
import { CircleAlert } from "lucide-react"
import { Alert, AlertDescription } from "~/components/ui/alert"
import { Button } from "~/components/ui/button"
import { Spinner } from "~/components/ui/spinner"
import { errorCodeOf, getErrorMessage, type TRPCErrorLike } from "~/lib/errors"
import { useTRPC } from "~/lib/trpc"

export type InstanceActionErrorProps = {
	error: TRPCErrorLike
	instanceId: string
	busy: boolean
	onCancelled: () => void | Promise<void>
}

export const ASK_AN_OWNER_MESSAGE = "Ask an owner to cancel the sign-in."

export const InstanceActionError = ({
	error,
	instanceId,
	busy,
	onCancelled,
}: InstanceActionErrorProps) => {
	const trpc = useTRPC()
	const me = useQuery(trpc.member.me.queryOptions())
	const cancelMutation = useMutation(
		trpc.instance.cancelAuthentication.mutationOptions({ onSuccess: onCancelled }),
	)

	const heldBySignIn = errorCodeOf(error) === "INSTANCE_AUTH_IN_PROGRESS"
	const role = me.data?.role
	const mayCancel = role !== undefined && can(role, "instance.authenticate")

	return (
		<Alert
			variant="error"
			icon={<CircleAlert />}
			action={
				heldBySignIn && mayCancel ? (
					<Button
						size="sm"
						variant="secondary"
						disabled={busy || cancelMutation.isPending}
						onClick={() => cancelMutation.mutate({ instanceId })}
					>
						{cancelMutation.isPending ? <Spinner label="Cancelling" /> : "Cancel sign-in"}
					</Button>
				) : undefined
			}
		>
			{getErrorMessage(error)}
			{heldBySignIn && role !== undefined && !mayCancel ? (
				<AlertDescription>{ASK_AN_OWNER_MESSAGE}</AlertDescription>
			) : null}
		</Alert>
	)
}
