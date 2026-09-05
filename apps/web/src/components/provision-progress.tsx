import { PROVISION_STEP_LABELS } from "@open-mcc/contracts"
import { Check, Loader } from "lucide-react"

export type ProvisionProgressProps = {
	step: string | null
	index: number | null
	total: number | null
}

export const ProvisionProgress = ({ step, index, total }: ProvisionProgressProps) => {
	const labels = total && total > 0 ? PROVISION_STEP_LABELS.slice(0, total) : PROVISION_STEP_LABELS
	const current = index ?? 0

	return (
		<div className="space-y-3">
			<div className="flex items-baseline justify-between">
				<p className="text-sm font-medium text-foreground">{step ?? "Starting"}</p>
				<p className="text-xs tabular-nums text-muted-foreground">
					Step {Math.min(current + 1, labels.length)} of {labels.length}
				</p>
			</div>

			<ol className="space-y-1.5">
				{labels.map((label, position) => {
					const done = position < current
					const running = position === current
					return (
						<li key={label} className="flex items-center gap-2.5 text-sm">
							<span className="grid size-4 shrink-0 place-items-center">
								{done ? (
									<Check className="size-3.5 text-success" />
								) : running ? (
									<Loader className="size-3.5 animate-spin-quick text-foreground" />
								) : (
									<span className="size-1.5 rounded-full bg-border" />
								)}
							</span>
							<span
								className={
									done
										? "text-muted-foreground"
										: running
											? "text-foreground"
											: "text-muted-foreground/60"
								}
							>
								{label}
							</span>
						</li>
					)
				})}
			</ol>
		</div>
	)
}
