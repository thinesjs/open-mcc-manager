import { ArrowDown } from "lucide-react"
import { AnimatePresence, motion, useReducedMotion } from "motion/react"
import { useCallback, useLayoutEffect, useRef, useState } from "react"
import { MinecraftText } from "~/components/minecraft-text"
import type { ConsoleLine } from "~/lib/minecraft-text"
import { isAtBottom } from "~/lib/scroll"

export type ConsoleOutputProps = {
	lines: readonly ConsoleLine[]
}

export const ConsoleOutput = ({ lines }: ConsoleOutputProps) => {
	const reduced = useReducedMotion() ?? false
	const viewport = useRef<HTMLPreElement>(null)
	const [pinned, setPinned] = useState(true)

	const scrollToLatest = useCallback(() => {
		const element = viewport.current
		if (!element) return
		element.scrollTop = element.scrollHeight
		setPinned(true)
	}, [])

	const onScroll = useCallback(() => {
		const element = viewport.current
		if (!element) return
		setPinned(isAtBottom(element))
	}, [])

	useLayoutEffect(() => {
		const element = viewport.current
		if (!element || !pinned || lines.length === 0) return
		element.scrollTop = element.scrollHeight
	}, [lines, pinned])

	return (
		<div className="relative">
			<pre
				ref={viewport}
				onScroll={onScroll}
				className="max-h-96 overflow-auto rounded-[var(--radius)] border border-border bg-card p-4 font-mono text-xs leading-relaxed text-foreground"
			>
				{lines.map((line) => (
					<MinecraftText key={line.key} value={line.text} />
				))}
			</pre>

			<AnimatePresence>
				{pinned ? null : (
					<motion.button
						type="button"
						onClick={scrollToLatest}
						initial={reduced ? { opacity: 0 } : { opacity: 0, y: 4 }}
						animate={reduced ? { opacity: 1 } : { opacity: 1, y: 0 }}
						exit={reduced ? { opacity: 0 } : { opacity: 0, y: 4 }}
						transition={{ duration: reduced ? 0.1 : 0.18, ease: [0.16, 1, 0.3, 1] }}
						className="absolute right-3 bottom-3 inline-flex items-center gap-1.5 rounded-full border border-border bg-background/95 px-3 py-1.5 text-xs font-medium text-foreground shadow-sm backdrop-blur transition-colors hover:bg-muted active:scale-[0.97]"
					>
						<ArrowDown className="size-3.5" />
						Jump to latest
					</motion.button>
				)}
			</AnimatePresence>
		</div>
	)
}
