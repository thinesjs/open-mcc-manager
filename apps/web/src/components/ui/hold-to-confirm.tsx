import { motion } from "motion/react"
import { useCallback, useEffect, useRef, useState } from "react"
import { buttonVariants } from "~/components/ui/button"
import { cn } from "~/lib/utils"

export type HoldToConfirmProps = {
	label: string
	holdingLabel: string
	durationMs?: number
	disabled?: boolean
	onConfirm: () => void
}

export const HOLD_DURATION_MS = 900

export const HoldToConfirm = ({
	label,
	holdingLabel,
	durationMs = HOLD_DURATION_MS,
	disabled = false,
	onConfirm,
}: HoldToConfirmProps) => {
	const [holding, setHolding] = useState(false)
	const timer = useRef<ReturnType<typeof setTimeout>>(undefined)

	const cancel = useCallback(() => {
		if (timer.current !== undefined) clearTimeout(timer.current)
		timer.current = undefined
		setHolding(false)
	}, [])

	useEffect(() => cancel, [cancel])

	const start = () => {
		if (disabled || holding) return
		setHolding(true)
		timer.current = setTimeout(() => {
			setHolding(false)
			onConfirm()
		}, durationMs)
	}

	return (
		<button
			type="button"
			disabled={disabled}
			aria-label={`${label}. Press and hold to confirm.`}
			onPointerDown={start}
			onPointerUp={cancel}
			onPointerLeave={cancel}
			onKeyDown={(event) => {
				if (event.key === "Enter" || event.key === " ") start()
			}}
			onKeyUp={cancel}
			onBlur={cancel}
			className={cn(
				buttonVariants({ variant: "destructive-outline", size: "sm" }),
				"relative isolate overflow-hidden",
			)}
		>
			<motion.span
				aria-hidden="true"
				className="absolute inset-y-0 left-0 -z-10 bg-destructive/24"
				initial={{ width: "0%" }}
				animate={{ width: holding ? "100%" : "0%" }}
				transition={holding ? { duration: durationMs / 1000, ease: "linear" } : { duration: 0.15 }}
			/>
			{holding ? holdingLabel : label}
		</button>
	)
}
