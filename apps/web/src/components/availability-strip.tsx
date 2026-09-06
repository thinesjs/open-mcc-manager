import type { Availability } from "@open-mcc/contracts"
import { cn } from "~/lib/utils"

export type AvailabilityStripProps = {
	availability: Availability
	goodLabel?: string | undefined
	badLabel?: string | undefined
	className?: string | undefined
}

const SEGMENTS = [
	{ key: "goodSeconds", tone: "bg-success" },
	{ key: "degradedSeconds", tone: "bg-warning" },
	{ key: "badSeconds", tone: "bg-error" },
	{ key: "unknownSeconds", tone: "bg-muted-foreground/30" },
	{ key: "excludedSeconds", tone: "bg-muted-foreground/15" },
] as const

export const AvailabilityStrip = ({
	availability,
	goodLabel = "Connected",
	badLabel = "Not connected",
	className,
}: AvailabilityStripProps) => {
	const labels: Record<(typeof SEGMENTS)[number]["key"], string> = {
		goodSeconds: goodLabel,
		degradedSeconds: "Degraded",
		badSeconds: badLabel,
		unknownSeconds: "Not measured",
		excludedSeconds: "Asleep",
	}
	const total = SEGMENTS.reduce((sum, segment) => sum + availability[segment.key], 0)
	if (total === 0) {
		return (
			<div
				className={cn("h-2 w-full rounded-full bg-muted-foreground/15", className)}
				title="Nothing measured yet"
			/>
		)
	}

	return (
		<div className={cn("flex h-2 w-full overflow-hidden rounded-full", className)}>
			{SEGMENTS.map((segment) => {
				const seconds = availability[segment.key]
				if (seconds === 0) return null
				const share = (seconds / total) * 100
				return (
					<div
						key={segment.key}
						className={segment.tone}
						style={{ width: `${share}%` }}
						title={`${labels[segment.key]}: ${Math.round(share)}%`}
					/>
				)
			})}
		</div>
	)
}
