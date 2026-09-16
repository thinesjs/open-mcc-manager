import { CatchBoundary, type ErrorComponentProps } from "@tanstack/react-router"
import { CircleAlert } from "lucide-react"
import { AnimatePresence, motion, useReducedMotion } from "motion/react"
import { type ReactNode, Suspense, useCallback, useLayoutEffect, useRef, useState } from "react"
import { Alert } from "~/components/ui/alert"
import { getErrorMessage } from "~/lib/errors"
import { cn } from "~/lib/utils"

export const FADE_SECONDS = 0.18

export const PAGE_LOADING_LABEL = "Loading"

const PAGE_SHIMMER_ROWS = ["first", "second", "third"] as const

export const fadeTransition = (reduced: boolean) =>
	({ duration: reduced ? 0 : FADE_SECONDS, ease: "linear" }) as const

const ShimmerBar = ({ className }: { className: string }) => (
	<div
		data-slot="shimmer-bar"
		className={cn("shimmer-bar animate-shimmer motion-reduce:animate-none", className)}
	/>
)

export const PageShimmer = () => (
	<div className="space-y-6">
		<div className="space-y-2">
			<ShimmerBar className="h-5 w-40 rounded-[var(--control-radius)]" />
			<ShimmerBar className="h-3.5 w-full max-w-md rounded-[var(--control-radius)]" />
		</div>
		<div className="space-y-3">
			{PAGE_SHIMMER_ROWS.map((row) => (
				<ShimmerBar key={row} className="h-16 w-full rounded-[var(--radius)]" />
			))}
		</div>
	</div>
)

type Phase = "pending" | "settled" | "instant"

const SettleSignal = ({ onSettle }: { onSettle: () => void }) => {
	useLayoutEffect(() => {
		onSettle()
	}, [onSettle])
	return null
}

const CELL = "col-start-1 row-start-1"

const PageFade = ({ children }: { children: ReactNode }) => {
	const reduced = useReducedMotion() ?? false
	const fade = fadeTransition(reduced)
	const painted = useRef(false)
	const [phase, setPhase] = useState<Phase>("pending")

	const onSettle = useCallback(() => {
		setPhase(painted.current ? "settled" : "instant")
	}, [])

	useLayoutEffect(() => {
		painted.current = true
	}, [])

	return (
		<div aria-busy={phase === "pending"} className="grid">
			{phase === "instant" ? null : (
				<AnimatePresence initial={false}>
					{phase === "pending" ? (
						<motion.div
							key="shimmer"
							aria-hidden="true"
							className={CELL}
							exit={{ opacity: 0 }}
							transition={fade}
						>
							<PageShimmer />
						</motion.div>
					) : null}
				</AnimatePresence>
			)}
			{phase === "pending" ? (
				<span role="status" className="sr-only">
					{PAGE_LOADING_LABEL}
				</span>
			) : null}
			<Suspense fallback={null}>
				<motion.div
					data-slot="page-content"
					className={CELL}
					initial={{ opacity: 0 }}
					animate={{ opacity: 1 }}
					transition={fade}
				>
					<SettleSignal onSettle={onSettle} />
					{children}
				</motion.div>
			</Suspense>
		</div>
	)
}

const PageLoadError = ({ error }: ErrorComponentProps) => (
	<Alert variant="error" icon={<CircleAlert />}>
		{getErrorMessage(error)}
	</Alert>
)

export type PageBoundaryProps = {
	resetKey: string
	children: ReactNode
}

export const PageBoundary = ({ resetKey, children }: PageBoundaryProps) => (
	<CatchBoundary getResetKey={() => resetKey} errorComponent={PageLoadError}>
		<PageFade key={resetKey}>{children}</PageFade>
	</CatchBoundary>
)
