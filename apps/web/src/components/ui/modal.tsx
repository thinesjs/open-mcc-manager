import { X } from "lucide-react"
import { motion, useReducedMotion } from "motion/react"
import type { ReactNode } from "react"
import { useEffect } from "react"

export type ModalProps = {
	open: boolean
	title: string
	description?: string
	onClose: () => void
	children: ReactNode
}

export const Modal = ({ open, title, description, onClose, children }: ModalProps) => {
	const reduced = useReducedMotion() ?? false

	useEffect(() => {
		if (!open) return
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") onClose()
		}
		document.addEventListener("keydown", onKey)
		return () => document.removeEventListener("keydown", onKey)
	}, [open, onClose])

	if (!open) return null

	return (
		<motion.div
			className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4 sm:items-center"
			initial={{ opacity: 0 }}
			animate={{ opacity: 1 }}
			transition={{ duration: reduced ? 0.1 : 0.15 }}
		>
			<button
				type="button"
				aria-label="Close"
				tabIndex={-1}
				onClick={onClose}
				className="absolute inset-0 cursor-default bg-black/40"
			/>
			<motion.div
				role="dialog"
				aria-modal="true"
				aria-label={title}
				initial={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.96 }}
				animate={reduced ? { opacity: 1 } : { opacity: 1, scale: 1 }}
				transition={{ type: "spring", duration: reduced ? 0.1 : 0.25, bounce: 0 }}
				className="relative my-auto w-full max-w-lg rounded-[var(--radius)] border border-border bg-popover p-5 shadow-lg"
			>
				<div className="flex items-start justify-between gap-4">
					<div>
						<h2 className="text-base font-semibold text-foreground">{title}</h2>
						{description ? (
							<p className="mt-1 text-sm text-muted-foreground">{description}</p>
						) : null}
					</div>
					<button
						type="button"
						aria-label="Close"
						onClick={onClose}
						className="text-muted-foreground transition-colors hover:text-foreground"
					>
						<X className="size-4" />
					</button>
				</div>
				<div className="mt-5">{children}</div>
			</motion.div>
		</motion.div>
	)
}
