import type { InstanceStatus } from "@open-mcc/contracts"
import { RotateCcw } from "lucide-react"
import { Button } from "~/components/ui/button"
import { Spinner } from "~/components/ui/spinner"

export type InstanceDangerZoneProps = {
	status: InstanceStatus
	interactive: boolean
	busy: boolean
	restartPending: boolean
	cancelAuthPending: boolean
	removePending: boolean
	onRestart: () => void
	onCancelAuth: () => void
	onRemove: () => void
}

export const InstanceDangerZone = ({
	status,
	interactive,
	busy,
	restartPending,
	cancelAuthPending,
	removePending,
	onRestart,
	onCancelAuth,
	onRemove,
}: InstanceDangerZoneProps) => (
	<div className="space-y-4">
		<section className="space-y-3 rounded-[var(--radius)] border border-border bg-card p-4">
			<div>
				<h2 className="text-sm font-semibold text-foreground">Restart</h2>
				<p className="text-xs text-muted-foreground">
					Applies your saved settings. The bot leaves the server for a few seconds.
				</p>
			</div>
			<Button
				size="sm"
				variant="secondary"
				disabled={busy || status !== "running"}
				onClick={onRestart}
			>
				{restartPending ? (
					<Spinner label="Restarting" />
				) : (
					<>
						<RotateCcw className="size-4" />
						Restart
					</>
				)}
			</Button>
			{status !== "running" ? (
				<p className="text-xs text-muted-foreground">
					Only a running instance can be restarted. Use Start instead.
				</p>
			) : null}
		</section>

		{interactive ? (
			<section className="space-y-3 rounded-[var(--radius)] border border-border bg-card p-4">
				<div>
					<h2 className="text-sm font-semibold text-foreground">Cancel a stuck sign-in</h2>
					<p className="text-xs text-muted-foreground">
						Ends a sign-in that was started but never finished.
					</p>
				</div>
				<Button size="sm" variant="secondary" disabled={busy} onClick={onCancelAuth}>
					{cancelAuthPending ? <Spinner label="Cancelling" /> : "Cancel sign-in"}
				</Button>
			</section>
		) : null}

		<section className="space-y-3 rounded-[var(--radius)] border border-destructive/40 bg-card p-4">
			<div>
				<h2 className="text-sm font-semibold text-foreground">Remove this instance</h2>
				<p className="text-xs text-muted-foreground">
					Deletes this bot and everything saved for it. This cannot be undone.
				</p>
			</div>
			<Button variant="destructive-outline" size="sm" onClick={onRemove} disabled={busy}>
				{removePending ? <Spinner label="Removing" /> : "Remove instance"}
			</Button>
		</section>
	</div>
)
