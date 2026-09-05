import { AnimatePresence, motion } from "motion/react"
import type { ReactNode } from "react"
import { useEffect, useRef, useState } from "react"

export type StatusTransitionProps = {
	value: string
	children: ReactNode
}

export const SELF_ARRIVING_MS = 180

export const StatusTransition = ({ value, children }: StatusTransitionProps) => {
	const mountedAt = useRef(Date.now())
	const [animate, setAnimate] = useState(false)

	useEffect(() => {
		if (Date.now() - mountedAt.current < 250) return
		setAnimate(true)
	}, [])

	if (!animate) return <>{children}</>

	return (
		<AnimatePresence mode="wait" initial={false}>
			<motion.span
				key={value}
				initial={{ opacity: 0, filter: "blur(2px)" }}
				animate={{ opacity: 1, filter: "blur(0px)" }}
				exit={{ opacity: 0, filter: "blur(2px)" }}
				transition={{ duration: SELF_ARRIVING_MS / 1000, ease: [0.26, 1, 0.5, 1] }}
				className="inline-flex"
			>
				{children}
			</motion.span>
		</AnimatePresence>
	)
}
