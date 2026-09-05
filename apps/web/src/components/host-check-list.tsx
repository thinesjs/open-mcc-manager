import { HOST_CHECK_LABELS, type HostCheckOutcome, type HostCheckReport } from "@open-mcc/contracts"
import { Check, CircleAlert, Minus, TriangleAlert } from "lucide-react"
import { motion, useReducedMotion } from "motion/react"

const ICON: Record<HostCheckOutcome, typeof Check> = {
	pass: Check,
	fail: CircleAlert,
	warn: TriangleAlert,
	skipped: Minus,
}

const TONE: Record<HostCheckOutcome, string> = {
	pass: "text-success",
	fail: "text-destructive",
	warn: "text-warning",
	skipped: "text-muted-foreground/60",
}

export const HostCheckList = ({ report }: { report: HostCheckReport }) => {
	const reduced = useReducedMotion() ?? false

	return (
		<ul className="space-y-2">
			{report.checks.map((check, index) => {
				const Icon = ICON[check.outcome]
				return (
					<motion.li
						key={check.name}
						initial={reduced ? false : { opacity: 0, y: 4 }}
						animate={{ opacity: 1, y: 0 }}
						transition={{ delay: reduced ? 0 : index * 0.04, duration: 0.2 }}
						className="flex items-start gap-2.5"
					>
						<Icon className={`mt-0.5 size-3.5 shrink-0 ${TONE[check.outcome]}`} aria-hidden />
						<div className="min-w-0">
							<p className="text-sm text-foreground">{HOST_CHECK_LABELS[check.name]}</p>
							<p className="text-xs leading-relaxed text-muted-foreground">{check.detail}</p>
						</div>
					</motion.li>
				)
			})}
		</ul>
	)
}
