import type { BucketAvailability, StatusSummary } from "@open-mcc/contracts"
import { uptimeRatio } from "@open-mcc/contracts"
import { formatPercent } from "~/lib/uptime"
import { cn } from "~/lib/utils"

export type UptimeBarsProps = {
	buckets: readonly BucketAvailability[]
	bucketSeconds: StatusSummary["bucketSeconds"]
	fromLabel: string
	goodLabel?: string | undefined
	partialLabel?: string | undefined
	badLabel?: string | undefined
}

type Verdict = "good" | "partial" | "bad" | "none"

export const verdictFor = (entry: BucketAvailability): Verdict => {
	const ratio = uptimeRatio(entry.availability)
	if (ratio === undefined) return "none"
	if (ratio >= 0.999) return "good"
	if (ratio >= 0.9) return "partial"
	return "bad"
}

const TONE: Record<Verdict, string> = {
	good: "bg-success/60",
	partial: "bg-error/55",
	bad: "bg-error/85",
	none: "bg-muted-foreground/10",
}

const SPAN = new Intl.DateTimeFormat(undefined, {
	month: "short",
	day: "numeric",
	hour: "numeric",
	minute: "2-digit",
})

const spanOf = (start: string, bucketSeconds: number): string => {
	const from = new Date(start)
	return SPAN.formatRange(from, new Date(from.getTime() + bucketSeconds * 1000))
}

export const UptimeBars = ({
	buckets,
	bucketSeconds,
	fromLabel,
	goodLabel = "Reachable",
	partialLabel = "Mostly reachable",
	badLabel = "Not reachable",
}: UptimeBarsProps) => {
	const label: Record<Verdict, string> = {
		good: goodLabel,
		partial: partialLabel,
		bad: badLabel,
		none: "No measurements",
	}
	return (
		<div className="@container space-y-1.5">
			<div className="flex h-6 gap-px @lg:gap-[2px]">
				{buckets.map((entry) => {
					const verdict = verdictFor(entry)
					const ratio = uptimeRatio(entry.availability)
					const percent =
						ratio === undefined || verdict === "good" ? "" : ` · ${formatPercent(ratio)}`
					return (
						<div
							key={entry.start}
							title={`${label[verdict]}${percent}\n${spanOf(entry.start, bucketSeconds)}`}
							className={cn(
								"min-w-0 flex-1 rounded-[2px] transition-opacity hover:opacity-70",
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
}
