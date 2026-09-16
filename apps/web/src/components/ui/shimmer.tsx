import { QueryErrorResetBoundary } from "@tanstack/react-query"
import { CatchBoundary } from "@tanstack/react-router"
import { CircleAlert } from "lucide-react"
import { AnimatePresence, motion, useReducedMotion } from "motion/react"
import { type ReactNode, Suspense, useCallback, useLayoutEffect, useRef, useState } from "react"
import { Alert } from "~/components/ui/alert"
import { Button } from "~/components/ui/button"
import { getErrorMessage, type TRPCErrorLike } from "~/lib/errors"
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

export const PageLoading = ({ label = PAGE_LOADING_LABEL }: { label?: string }) => (
	<div>
		<div aria-hidden="true">
			<PageShimmer />
		</div>
		<span role="status" className="sr-only">
			{label}
		</span>
	</div>
)

type Phase = "waiting" | "revealed" | "instant"

const SettleSignal = ({ onSettle }: { onSettle: () => void }) => {
	useLayoutEffect(onSettle, [onSettle])
	return null
}

const PendingSignal = ({ onPending }: { onPending: () => void }) => {
	useLayoutEffect(onPending, [onPending])
	return null
}

const CELL = "col-start-1 row-start-1"

const PageFade = ({ children }: { children: ReactNode }) => {
	const reduced = useReducedMotion() ?? false
	const fade = fadeTransition(reduced)
	const committed = useRef(false)
	const [phase, setPhase] = useState<Phase>("waiting")

	const onSettle = useCallback(() => {
		setPhase((current) => {
			if (current !== "waiting") return current
			return committed.current ? "revealed" : "instant"
		})
	}, [])

	const onPending = useCallback(() => {
		setPhase("waiting")
	}, [])

	useLayoutEffect(() => {
		committed.current = true
	}, [])

	const waiting = phase === "waiting"

	return (
		<div aria-busy={waiting} className="grid">
			{phase === "instant" ? null : (
				<AnimatePresence initial={false}>
					{waiting ? (
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
			<span role="status" className="sr-only">
				{waiting ? PAGE_LOADING_LABEL : ""}
			</span>
			<Suspense fallback={<PendingSignal onPending={onPending} />}>
				<motion.div
					data-slot="page-content"
					data-fade-seconds={fade.duration}
					className={CELL}
					initial={{ opacity: 0 }}
					animate={{ opacity: waiting ? 0 : 1 }}
					transition={phase === "instant" ? fadeTransition(true) : fade}
				>
					<SettleSignal onSettle={onSettle} />
					{children}
				</motion.div>
			</Suspense>
		</div>
	)
}

const PageLoadError = ({ error, onRetry }: { error: TRPCErrorLike; onRetry: () => void }) => (
	<Alert
		variant="error"
		icon={<CircleAlert />}
		action={
			<Button size="sm" variant="outline" onClick={onRetry}>
				Try again
			</Button>
		}
	>
		{getErrorMessage(error)}
	</Alert>
)

export type PageBoundaryProps = {
	resetKey: string
	children: ReactNode
}

export const PageBoundary = ({ resetKey, children }: PageBoundaryProps) => (
	<QueryErrorResetBoundary>
		{({ reset }) => (
			<CatchBoundary
				getResetKey={() => resetKey}
				errorComponent={({ error, reset: clearError }) => (
					<PageLoadError
						error={error}
						onRetry={() => {
							reset()
							clearError()
						}}
					/>
				)}
			>
				<PageFade key={resetKey}>{children}</PageFade>
			</CatchBoundary>
		)}
	</QueryErrorResetBoundary>
)
