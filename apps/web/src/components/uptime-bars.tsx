import type { BucketAvailability, StatusSummary } from "@open-mcc/contracts"
import { uptimeRatio } from "@open-mcc/contracts"
import type { KeyboardEvent } from "react"
import { useRef, useState } from "react"
import { Tooltip } from "~/components/ui/tooltip"
import { formatPercent } from "~/lib/uptime"
import { cn } from "~/lib/utils"

export type UptimeBarsProps = {
	buckets: readonly BucketAvailability[]
	bucketSeconds: StatusSummary["bucketSeconds"]
	goodLabel?: string | undefined
	partialLabel?: string | undefined
	badLabel?: string | undefined
	subject?: string | undefined
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

const HOUR_SECONDS = 60 * 60

const sinceLabel = (seconds: number): string =>
	seconds > 24 * HOUR_SECONDS
		? `${Math.round(seconds / (24 * HOUR_SECONDS))} days ago`
		: `${Math.round(seconds / HOUR_SECONDS)} hours ago`

const BAR_CLASS =
	"min-w-0 flex-1 rounded-[2px] transition-opacity hover:opacity-70 focus-visible:opacity-70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"

export const UptimeBars = ({
	buckets,
	bucketSeconds,
	goodLabel = "Reachable",
	partialLabel = "Mostly reachable",
	badLabel = "Not reachable",
	subject,
}: UptimeBarsProps) => {
	const label: Record<Verdict, string> = {
		good: goodLabel,
		partial: partialLabel,
		bad: badLabel,
		none: "No measurements",
	}
	const barRefs = useRef<Array<HTMLButtonElement | null>>([])
	const [activeIndex, setActiveIndex] = useState(buckets.length - 1)
	const rovingIndex = Math.min(activeIndex, buckets.length - 1)

	const focusBar = (index: number) => {
		const clamped = Math.min(Math.max(index, 0), buckets.length - 1)
		barRefs.current[clamped]?.focus()
	}

	const onRowKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		if (event.key === "ArrowLeft") {
			event.preventDefault()
			focusBar(rovingIndex - 1)
			return
		}
		if (event.key === "ArrowRight") {
			event.preventDefault()
			focusBar(rovingIndex + 1)
			return
		}
		if (event.key === "Home") {
			event.preventDefault()
			focusBar(0)
			return
		}
		if (event.key === "End") {
			event.preventDefault()
			focusBar(buckets.length - 1)
		}
	}

	return (
		<div className="@container space-y-1.5">
			<div
				role="toolbar"
				aria-label={subject === undefined ? "Uptime" : `${subject} uptime`}
				className="flex h-6 gap-px @lg:gap-[2px]"
				onKeyDown={onRowKeyDown}
			>
				{buckets.map((entry, index) => {
					const verdict = verdictFor(entry)
					const ratio = uptimeRatio(entry.availability)
					const percent =
						ratio === undefined || verdict === "good" ? "" : ` · ${formatPercent(ratio)}`
					const summary = `${label[verdict]}${percent}`
					const span = spanOf(entry.start, bucketSeconds)
					return (
						<Tooltip
							key={entry.start}
							content={
								<>
									{summary}
									<br />
									{span}
								</>
							}
							render={
								<button
									type="button"
									ref={(element) => {
										barRefs.current[index] = element
									}}
									tabIndex={index === rovingIndex ? 0 : -1}
									onFocus={() => setActiveIndex(index)}
									aria-label={`${summary}, ${span}`}
									className={cn(BAR_CLASS, TONE[verdict])}
								/>
							}
						/>
					)
				})}
			</div>
			<div className="flex justify-between text-xs text-muted-foreground">
				<span>{sinceLabel(buckets.length * bucketSeconds)}</span>
				<span>Today</span>
			</div>
		</div>
	)
}
