import type * as React from "react"
import { cn } from "~/lib/utils"

export type InputProps = React.InputHTMLAttributes<HTMLInputElement>

export const Input = ({ className, ...props }: InputProps) => (
	<input
		className={cn(
			"flex h-9 w-full rounded-[var(--control-radius)] border border-input bg-popover px-3 text-sm text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
			className,
		)}
		{...props}
	/>
)
