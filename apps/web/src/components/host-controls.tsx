import type { HostPublic, Role } from "@open-mcc/contracts"
import { Plus } from "lucide-react"
import { Button } from "~/components/ui/button"
import { Spinner } from "~/components/ui/spinner"
import { mayUseHostControl } from "~/lib/host-actions"

export type HostControlsProps = {
	host: HostPublic
	role: Role | undefined
	provisionPending: boolean
	removePending: boolean
	onCreateInstance: () => void
	onSetUp: () => void
	onRemove: () => void
}

export const HostControls = ({
	host,
	role,
	provisionPending,
	removePending,
	onCreateInstance,
	onSetUp,
	onRemove,
}: HostControlsProps) => (
	<div className="flex gap-3">
		{host.status === "ready" && mayUseHostControl(role, "createInstance") ? (
			<Button onClick={onCreateInstance}>
				<Plus className="size-4" />
				New instance
			</Button>
		) : null}
		{mayUseHostControl(role, "setUp") ? (
			<Button
				variant={host.status === "ready" ? "secondary" : "default"}
				onClick={onSetUp}
				disabled={provisionPending || host.status === "provisioning" || host.status === "removing"}
			>
				{provisionPending ? (
					<Spinner label="Setting up" />
				) : host.status === "ready" ? (
					"Repair setup"
				) : (
					"Set up"
				)}
			</Button>
		) : null}
		{mayUseHostControl(role, "remove") ? (
			<Button
				variant="destructive-outline"
				onClick={onRemove}
				disabled={removePending || host.status === "provisioning" || host.status === "removing"}
			>
				{removePending ? <Spinner label="Removing" /> : "Remove"}
			</Button>
		) : null}
	</div>
)
