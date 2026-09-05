import { X } from "lucide-react"
import { motion, useReducedMotion } from "motion/react"
import { useEffect } from "react"
import { Button } from "~/components/ui/button"
import { HoldToConfirm } from "~/components/ui/hold-to-confirm"

export type ConfirmDialogProps = {
	open: boolean
	title: string
	description: string
	confirmLabel: string
	cancelLabel?: string
	destructive?: boolean
	busy?: boolean
	error?: string | undefined
	onConfirm: () => void
	onCancel: () => void
}

export const ConfirmDialog = ({
	open,
	title,
	description,
	confirmLabel,
	cancelLabel = "Cancel",
	destructive = false,
	busy = false,
	error,
	onConfirm,
	onCancel,
}: ConfirmDialogProps) => {
	const reduced = useReducedMotion() ?? false

	useEffect(() => {
		if (!open) return
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") onCancel()
		}
		document.addEventListener("keydown", onKey)
		return () => document.removeEventListener("keydown", onKey)
	}, [open, onCancel])

	if (!open) return null

	return (
		<motion.div
			className="fixed inset-0 z-50 flex items-center justify-center p-4"
			initial={{ opacity: 0 }}
			animate={{ opacity: 1 }}
			transition={{ duration: reduced ? 0.1 : 0.15 }}
		>
			<button
				type="button"
				aria-label={cancelLabel}
				tabIndex={-1}
				onClick={onCancel}
				className="absolute inset-0 cursor-default bg-black/40"
			/>
			<motion.div
				role="dialog"
				aria-modal="true"
				aria-label={title}
				initial={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.96 }}
				animate={reduced ? { opacity: 1 } : { opacity: 1, scale: 1 }}
				transition={{ type: "spring", duration: reduced ? 0.1 : 0.25, bounce: 0 }}
				className="relative w-full max-w-md rounded-[var(--radius)] border border-border bg-popover p-5 shadow-lg"
			>
				<div className="flex items-start justify-between gap-4">
					<h2 className="text-base font-semibold text-foreground">{title}</h2>
					<button
						type="button"
						aria-label={cancelLabel}
						onClick={onCancel}
						className="text-muted-foreground hover:text-foreground"
					>
						<X className="size-4" />
					</button>
				</div>
				<p className="mt-2 text-sm text-muted-foreground">{description}</p>
				{error ? (
					<div
						role="alert"
						className="mt-3 rounded-[var(--control-radius)] border border-error/32 bg-error-surface px-3 py-2 text-sm text-error-foreground"
					>
						{error}
					</div>
				) : null}
				<div className="mt-5 flex justify-end gap-2">
					<Button size="sm" variant="secondary" onClick={onCancel} disabled={busy}>
						{cancelLabel}
					</Button>
					{destructive ? (
						<HoldToConfirm
							label={busy ? "Working…" : confirmLabel}
							holdingLabel="Keep holding…"
							disabled={busy}
							onConfirm={onConfirm}
						/>
					) : (
						<Button autoFocus size="sm" onClick={onConfirm} disabled={busy}>
							{busy ? "Working…" : confirmLabel}
						</Button>
					)}
				</div>
			</motion.div>
		</motion.div>
	)
}
