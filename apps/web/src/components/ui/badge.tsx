import type * as React from "react"
import { cn } from "~/lib/utils"

export type BadgeVariant = "default" | "success" | "warning" | "error" | "info" | "update"

const VARIANT_CLASSES: Record<BadgeVariant, string> = {
	default: "border-transparent bg-secondary text-secondary-foreground",
	success: "border-transparent bg-success/10 text-success-foreground",
	warning: "border-transparent bg-warning-surface text-warning-foreground",
	error: "border-transparent bg-error-surface text-error-foreground",
	info: "border-transparent bg-info/10 text-info-foreground",
	update: "border-transparent bg-update-surface text-update-foreground",
}

export type BadgeProps = React.HTMLAttributes<HTMLSpanElement> & {
	variant?: BadgeVariant
}

export const Badge = ({ className, variant = "default", ...props }: BadgeProps) => (
	<span
		className={cn(
			"inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium",
			VARIANT_CLASSES[variant],
			className,
		)}
		{...props}
	/>
)
