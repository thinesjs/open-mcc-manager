import { useSuspenseQuery } from "@tanstack/react-query"
import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { EnrollHostSteps } from "~/components/enroll-host-steps"
import { mayUseHostControl } from "~/lib/host-actions"
import { useTRPC } from "~/lib/trpc"

export const Route = createFileRoute("/_authenticated/hosts/new")({
	component: EnrollHostPage,
})

function EnrollHostPage() {
	const navigate = useNavigate()
	const trpc = useTRPC()
	const me = useSuspenseQuery(trpc.member.me.queryOptions())
	const mayEnroll = mayUseHostControl(me.data.role, "enroll")

	return (
		<div className="max-w-2xl space-y-6">
			<div>
				<h1 className="text-lg font-semibold text-foreground">Enroll a host</h1>
				<p className="text-sm text-muted-foreground">
					{mayEnroll
						? "Select a key, provide the address, run the setup command, then verify the host key."
						: "Only an owner can add a server."}
				</p>
			</div>
			{mayEnroll ? (
				<EnrollHostSteps
					onEnrolled={(hostId) => navigate({ to: "/hosts/$hostId", params: { hostId } })}
				/>
			) : null}
		</div>
	)
}
