import { AnimatePresence, motion, useReducedMotion } from "motion/react"
import type { ReactNode } from "react"
import useMeasure from "react-use-measure"

export const STEP_TRAVEL_PX = 120

export type StepsProps = {
	step: number
	direction: 1 | -1
	children: ReactNode
}

export const Steps = ({ step, direction, children }: StepsProps) => {
	const [ref, bounds] = useMeasure()
	const reduced = useReducedMotion() ?? false
	const travel = reduced ? 0 : STEP_TRAVEL_PX

	return (
		<motion.div
			animate={{ height: bounds.height > 0 ? bounds.height : "auto" }}
			transition={{ type: "spring", duration: reduced ? 0.1 : 0.32, bounce: 0 }}
			className="relative overflow-hidden"
		>
			<AnimatePresence mode="popLayout" initial={false} custom={direction}>
				<motion.div
					key={step}
					custom={direction}
					initial={{ opacity: 0, x: direction * travel }}
					animate={{ opacity: 1, x: 0 }}
					exit={{ opacity: 0, x: direction * -travel }}
					transition={{ type: "spring", duration: reduced ? 0.1 : 0.32, bounce: 0 }}
				>
					<div ref={ref}>{children}</div>
				</motion.div>
			</AnimatePresence>
		</motion.div>
	)
}

export type StepIndicatorProps = {
	total: number
	current: number
	labels: readonly string[]
}

export const StepIndicator = ({ total, current, labels }: StepIndicatorProps) => (
	<ol className="flex items-center gap-2" aria-label={`Step ${current + 1} of ${total}`}>
		{Array.from({ length: total }, (_, index) => (
			<li key={labels[index] ?? index} className="flex items-center gap-2">
				<span
					aria-current={index === current ? "step" : undefined}
					className={
						index <= current
							? "h-1 w-8 rounded-full bg-primary transition-colors duration-200"
							: "h-1 w-8 rounded-full bg-accent transition-colors duration-200"
					}
				/>
			</li>
		))}
	</ol>
)
