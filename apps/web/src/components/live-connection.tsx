import type { McpSessionStatus } from "@open-mcc/contracts/boundary/mcp"
import { Spinner } from "~/components/ui/spinner"

export type LiveConnectionProps = {
	running: boolean
	pending: boolean
	liveStatus: McpSessionStatus | null | undefined
}

export const LiveConnection = ({ running, pending, liveStatus }: LiveConnectionProps) => {
	if (!running)
		return <p className="text-sm text-muted-foreground">Not live. The bot is not running.</p>
	if (pending) return <Spinner label="Reading live state" />
	if (!liveStatus) {
		return (
			<p className="text-sm text-muted-foreground">
				Not answering yet. The client only opens this once it has joined a server.
			</p>
		)
	}

	return (
		<dl className="grid gap-x-8 gap-y-2 sm:grid-cols-2">
			{liveStatus.username ? (
				<div className="flex justify-between gap-4">
					<dt className="text-sm text-muted-foreground">Signed in as</dt>
					<dd className="text-sm text-foreground">{liveStatus.username}</dd>
				</div>
			) : null}
			<div className="flex justify-between gap-4">
				<dt className="text-sm text-muted-foreground">Connected to</dt>
				<dd className="text-sm text-foreground">
					{liveStatus.host}:{liveStatus.port}
				</dd>
			</div>
			<div className="flex justify-between gap-4">
				<dt className="text-sm text-muted-foreground">Protocol</dt>
				<dd className="text-sm tabular-nums text-foreground">{liveStatus.protocolVersion}</dd>
			</div>
			<div className="flex justify-between gap-4">
				<dt className="text-sm text-muted-foreground">World data</dt>
				<dd className="text-sm text-foreground">
					{liveStatus.terrainEnabled ? "Terrain" : "No terrain"}
				</dd>
			</div>
		</dl>
	)
}
