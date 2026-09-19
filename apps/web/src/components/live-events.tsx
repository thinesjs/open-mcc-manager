import { describeLiveEvent, type LiveEvent } from "~/lib/live-events"

export type { LiveEvent }

export type LiveEventsProps = {
	events: readonly LiveEvent[]
}

const timeOf = (value: string): string => {
	const at = new Date(value)
	return Number.isNaN(at.getTime()) ? "" : at.toLocaleTimeString()
}

export const LiveEvents = ({ events }: LiveEventsProps) => (
	<ol className="max-h-48 space-y-1 overflow-auto rounded-[var(--radius)] border border-border bg-card p-3 text-xs">
		{events.map((event) => (
			<li key={event.id} className="flex gap-2">
				<span className="shrink-0 tabular-nums text-muted-foreground">
					{timeOf(event.timestampUtc)}
				</span>
				<span className="text-foreground">{describeLiveEvent(event)}</span>
			</li>
		))}
	</ol>
)
