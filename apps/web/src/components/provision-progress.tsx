import { type HostMode, provisionStepLabels } from "@open-mcc/contracts"
import { Check, CircleX, Loader } from "lucide-react"

export type ProvisionProgressProps = {
	step: string | null
	index: number | null
	total: number | null
	failure?: string | null
	running: boolean
	mode: HostMode
}

type StepState = "done" | "running" | "failed" | "waiting"

export const stateForStep = (position: number, current: number, running: boolean): StepState => {
	if (position < current) return "done"
	if (position > current) return "waiting"
	return running ? "running" : "failed"
}

export const ProvisionProgress = ({
	step,
	index,
	total,
	failure,
	running,
	mode,
}: ProvisionProgressProps) => {
	const all = provisionStepLabels(mode)
	const labels = total && total > 0 ? all.slice(0, total) : all
	const current = index ?? 0

	return (
		<div className="space-y-3">
			<div className="flex items-baseline justify-between gap-4">
				<p className="text-sm font-medium text-foreground">
					{running ? (step ?? "Starting") : `Stopped at ${step ?? "the first step"}`}
				</p>
				<p className="shrink-0 text-xs tabular-nums text-muted-foreground">
					Step {Math.min(current + 1, labels.length)} of {labels.length}
				</p>
			</div>

			<ol className="space-y-1.5">
				{labels.map((label, position) => {
					const state = stateForStep(position, current, running)
					return (
						<li key={label} className="space-y-1">
							<div className="flex items-center gap-2.5 text-sm">
								<span className="grid size-4 shrink-0 place-items-center">
									{state === "done" ? (
										<Check className="size-3.5 text-success" />
									) : state === "running" ? (
										<Loader className="size-3.5 animate-spin-quick text-foreground" />
									) : state === "failed" ? (
										<CircleX className="size-3.5 text-error" />
									) : (
										<span className="size-1.5 rounded-full bg-border" />
									)}
								</span>
								<span
									className={
										state === "failed"
											? "text-error-foreground"
											: state === "running"
												? "text-foreground"
												: state === "done"
													? "text-muted-foreground"
													: "text-muted-foreground/60"
									}
								>
									{label}
								</span>
							</div>
							{state === "failed" && failure ? (
								<p className="ml-6.5 break-words text-sm text-error-foreground/80">{failure}</p>
							) : null}
						</li>
					)
				})}
			</ol>
		</div>
	)
}
