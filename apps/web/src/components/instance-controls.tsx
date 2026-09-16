import type { InstanceStatus } from "@open-mcc/contracts"
import { KeyRound, Play, Square } from "lucide-react"
import { Button } from "~/components/ui/button"
import { Spinner } from "~/components/ui/spinner"

export type InstanceControlsProps = {
	status: InstanceStatus
	interactive: boolean
	hasChallenge: boolean
	busy: boolean
	authenticatePending: boolean
	completePending: boolean
	onAuthenticate: () => void
	onComplete: () => void
	onStart: () => void
	onStop: () => void
}

export const InstanceControls = ({
	status,
	interactive,
	hasChallenge,
	busy,
	authenticatePending,
	completePending,
	onAuthenticate,
	onComplete,
	onStart,
	onStop,
}: InstanceControlsProps) => (
	<div className="flex flex-wrap gap-2">
		{!interactive ? null : (
			<>
				<Button
					size="sm"
					variant={status === "needs_auth" ? "default" : "secondary"}
					disabled={busy}
					onClick={onAuthenticate}
				>
					{authenticatePending ? (
						<Spinner label="Requesting a code" />
					) : (
						<>
							<KeyRound className="size-4" />
							{status === "needs_auth" ? "Get a sign-in code" : "Re-authenticate"}
						</>
					)}
				</Button>
				{status === "needs_auth" && hasChallenge ? (
					<Button size="sm" variant="secondary" disabled={busy} onClick={onComplete}>
						{completePending ? <Spinner label="Checking" /> : "I finished signing in"}
					</Button>
				) : null}
			</>
		)}
		{status === "running" ? (
			<Button size="sm" variant="secondary" disabled={busy} onClick={onStop}>
				<Square className="size-4" />
				Stop
			</Button>
		) : (
			<Button size="sm" disabled={busy || status === "needs_auth"} onClick={onStart}>
				<Play className="size-4" />
				Start
			</Button>
		)}
	</div>
)
