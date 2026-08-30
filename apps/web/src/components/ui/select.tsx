import type * as React from "react"
import { cn } from "~/lib/utils"

export type SelectProps = React.SelectHTMLAttributes<HTMLSelectElement>

export const Select = ({ className, ...props }: SelectProps) => (
	<select
		className={cn(
			"flex h-9 w-full rounded-[var(--control-radius)] border border-input bg-popover px-3 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
			className,
		)}
		{...props}
	/>
)
