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
					Select a key, provide the address, run the setup command, then verify the host key.
				</p>
			</div>
			<EnrollHostSteps
				onEnrolled={(hostId) => navigate({ to: "/hosts/$hostId", params: { hostId } })}
			/>
		</div>
	)
}
