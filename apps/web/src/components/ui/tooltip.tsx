import { Tooltip as BaseTooltip } from "@base-ui/react/tooltip"
import type { ReactElement, ReactNode } from "react"

export type TooltipProps = {
	content: ReactNode
	children?: ReactNode
	render?: ReactElement
}

export const Tooltip = ({ content, children, render }: TooltipProps) => (
	<BaseTooltip.Provider delay={250} closeDelay={80}>
		<BaseTooltip.Root>
			<BaseTooltip.Trigger
				render={
					render ?? <span className="cursor-help underline decoration-dotted underline-offset-4" />
				}
			>
				{children}
			</BaseTooltip.Trigger>
			<BaseTooltip.Portal>
				<BaseTooltip.Positioner sideOffset={6} className="z-50">
					<BaseTooltip.Popup
						data-slot="tooltip-popup"
						className="max-w-64 rounded-[var(--control-radius)] border border-border bg-popover px-2.5 py-1.5 text-xs text-popover-foreground shadow-md transition-[transform,opacity] duration-150 ease-out data-[ending-style]:scale-95 data-[ending-style]:opacity-0 data-[starting-style]:scale-95 data-[starting-style]:opacity-0 motion-reduce:transition-none"
					>
						{content}
					</BaseTooltip.Popup>
				</BaseTooltip.Positioner>
			</BaseTooltip.Portal>
		</BaseTooltip.Root>
	</BaseTooltip.Provider>
)
