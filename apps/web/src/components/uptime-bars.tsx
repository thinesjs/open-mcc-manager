import type { BucketAvailability } from "@open-mcc/contracts"
import { uptimeRatio } from "@open-mcc/contracts"
import { formatPercent } from "~/lib/uptime"
import { cn } from "~/lib/utils"

export type UptimeBarsProps = {
	buckets: readonly BucketAvailability[]
	granularity: "hour" | "day"
	fromLabel: string
	goodLabel?: string | undefined
	badLabel?: string | undefined
}

type DayVerdict = "good" | "partial" | "bad" | "none"

export const verdictFor = (entry: BucketAvailability): DayVerdict => {
	const ratio = uptimeRatio(entry.availability)
	if (ratio === undefined) return "none"
	if (ratio >= 0.999) return "good"
	if (ratio >= 0.9) return "partial"
	return "bad"
}

const TONE: Record<DayVerdict, string> = {
	good: "bg-success",
	partial: "bg-warning",
	bad: "bg-error",
	none: "bg-muted-foreground/20",
}

const readableStart = (start: string, granularity: "hour" | "day"): string => {
	const moment = new Date(start)
	return granularity === "hour"
		? moment.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric" })
		: moment.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })
}

export const UptimeBars = ({
	buckets,
	granularity,
	fromLabel,
	goodLabel = "Reachable",
	badLabel = "Not reachable",
}: UptimeBarsProps) => (
	<div className="space-y-1.5">
		<div className="flex items-stretch gap-[2px]">
			{buckets.map((entry) => {
				const verdict = verdictFor(entry)
				const ratio = uptimeRatio(entry.availability)
				const summary =
					verdict === "none"
						? "No measurements"
						: verdict === "good"
							? goodLabel
							: `${badLabel} · ${ratio === undefined ? "" : formatPercent(ratio)}`
				return (
					<div
						key={entry.start}
						title={`${summary}\n${readableStart(entry.start, granularity)}`}
						className={cn(
							"h-8 min-w-[3px] flex-1 rounded-[2px] transition-opacity hover:opacity-70",
							TONE[verdict],
						)}
					/>
				)
			})}
		</div>
		<div className="flex justify-between text-xs text-muted-foreground">
			<span>{fromLabel}</span>
			<span>Today</span>
		</div>
	</div>
)
