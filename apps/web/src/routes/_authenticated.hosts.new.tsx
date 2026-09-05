import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { EnrollHostSteps } from "~/components/enroll-host-steps"

export const Route = createFileRoute("/_authenticated/hosts/new")({
	component: EnrollHostPage,
})

function EnrollHostPage() {
	const navigate = useNavigate()

	return (
		<div className="max-w-2xl space-y-6">
			<div>
				<h1 className="text-lg font-semibold text-foreground">Enroll a host</h1>
				<p className="text-sm text-muted-foreground">
					Pick a key, say where the host is, run one command on it, then confirm its identity.
				</p>
			</div>
			<EnrollHostSteps
				onEnrolled={(hostId) => navigate({ to: "/hosts/$hostId", params: { hostId } })}
			/>
		</div>
	)
}
