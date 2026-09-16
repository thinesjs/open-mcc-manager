import { useSuspenseQuery } from "@tanstack/react-query"
import { createFileRoute } from "@tanstack/react-router"
import { CircleAlert } from "lucide-react"
import { MembersPanel } from "~/components/members-panel"
import { Alert } from "~/components/ui/alert"
import { getErrorMessage } from "~/lib/errors"
import { useTRPC } from "~/lib/trpc"

export const Route = createFileRoute("/_authenticated/members")({
	component: MembersPage,
})

function MembersPage() {
	const trpc = useTRPC()
	const me = useSuspenseQuery(trpc.member.me.queryOptions())

	return (
		<div className="space-y-6">
			{me.isError ? (
				<Alert variant="error" icon={<CircleAlert />}>
					{getErrorMessage(me.error)}
				</Alert>
			) : null}
			<MembersPanel role={me.data.role} />
		</div>
	)
}
