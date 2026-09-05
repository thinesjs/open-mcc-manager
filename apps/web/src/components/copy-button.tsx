import { Check, Copy } from "lucide-react"
import { AnimatePresence, motion, useReducedMotion } from "motion/react"
import { useEffect, useState } from "react"
import { Button } from "~/components/ui/button"
import { durationFor, variantsFor } from "~/lib/motion"

export type CopyButtonProps = {
	value: string
	label: string
}

export const COPIED_FEEDBACK_MS = 1600

export const CopyButton = ({ value, label }: CopyButtonProps) => {
	const [copied, setCopied] = useState(false)
	const reduced = useReducedMotion() ?? false
	const variants = variantsFor(reduced)

	useEffect(() => {
		if (!copied) return
		const timer = setTimeout(() => setCopied(false), COPIED_FEEDBACK_MS)
		return () => clearTimeout(timer)
	}, [copied])

	return (
		<Button
			type="button"
			variant="outline"
			size="icon"
			aria-label={copied ? `${label} copied to clipboard` : `Copy ${label.toLowerCase()}`}
			onClick={() => {
				void navigator.clipboard.writeText(value).then(() => setCopied(true))
			}}
		>
			<span aria-live="polite" className="sr-only">
				{copied ? `${label} copied to clipboard` : ""}
			</span>
			<AnimatePresence mode="wait" initial={false}>
				{copied ? (
					<motion.span
						key="copied"
						variants={variants}
						initial="hidden"
						animate="visible"
						exit="hidden"
						transition={{ type: "spring", duration: durationFor(reduced, 0.2), bounce: 0 }}
						className="flex"
					>
						<Check className="size-4 text-success" />
					</motion.span>
				) : (
					<motion.span
						key="copy"
						variants={variants}
						initial="hidden"
						animate="visible"
						exit="hidden"
						transition={{ type: "spring", duration: durationFor(reduced, 0.2), bounce: 0 }}
						className="flex"
					>
						<Copy className="size-4" />
					</motion.span>
				)}
			</AnimatePresence>
		</Button>
	)
}
