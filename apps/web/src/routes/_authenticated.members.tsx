import { useSuspenseQuery } from "@tanstack/react-query"
import { createFileRoute } from "@tanstack/react-router"
import { MembersPanel } from "~/components/members-panel"
import { useTRPC } from "~/lib/trpc"

export const Route = createFileRoute("/_authenticated/members")({
	component: MembersPage,
})

function MembersPage() {
	const trpc = useTRPC()
	const me = useSuspenseQuery(trpc.member.me.queryOptions())

	return <MembersPanel role={me.data.role} />
}
