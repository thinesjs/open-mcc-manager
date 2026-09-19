import { STATUS_RANGES, type StatusRange } from "@open-mcc/contracts"
import { Spinner } from "~/components/ui/spinner"
import { cn } from "~/lib/utils"

const RANGE_LABEL: Record<StatusRange, string> = {
	"24h": "24 hours",
	"7d": "7 days",
	"30d": "30 days",
}

export type StatusRangePickerProps = {
	range: StatusRange
	pending: boolean
	onChange: (range: StatusRange) => void
}

export const StatusRangePicker = ({ range, pending, onChange }: StatusRangePickerProps) => (
	<div data-slot="status-range" className="flex items-center gap-1" aria-busy={pending}>
		{pending ? <Spinner label="Loading status" className="mr-1 text-muted-foreground" /> : null}
		{STATUS_RANGES.map((option) => (
			<button
				key={option}
				type="button"
				onClick={() => onChange(option)}
				className={cn(
					"rounded-[var(--control-radius)] px-2 py-1 text-xs transition-colors active:scale-[0.97]",
					option === range
						? "bg-accent text-foreground"
						: "text-muted-foreground hover:text-foreground",
				)}
			>
				{RANGE_LABEL[option]}
			</button>
		))}
	</div>
)
