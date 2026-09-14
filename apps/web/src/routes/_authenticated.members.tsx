import { useQuery } from "@tanstack/react-query"
import { createFileRoute } from "@tanstack/react-router"
import { CircleAlert } from "lucide-react"
import { MembersPanel } from "~/components/members-panel"
import { Alert } from "~/components/ui/alert"
import { LoadingBlock } from "~/components/ui/spinner"
import { getErrorMessage } from "~/lib/errors"
import { useTRPC } from "~/lib/trpc"

export const Route = createFileRoute("/_authenticated/members")({
	component: MembersPage,
})

function MembersPage() {
	const trpc = useTRPC()
	const me = useQuery(trpc.member.me.queryOptions())

	if (me.isPending) return <LoadingBlock label="Loading members" />

	if (me.isError) {
		return (
			<Alert variant="error" icon={<CircleAlert />}>
				{getErrorMessage(me.error)}
			</Alert>
		)
	}

	return <MembersPanel role={me.data.role} />
}
