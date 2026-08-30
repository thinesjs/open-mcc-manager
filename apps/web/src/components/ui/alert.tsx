import type * as React from "react"
import { cn } from "~/lib/utils"

export type AlertVariant = "error" | "success" | "warning" | "info"

const VARIANT_CLASSES: Record<AlertVariant, string> = {
	error: "border-error/20 bg-error-surface text-error-foreground",
	success: "border-success/20 bg-success/10 text-success-foreground",
	warning: "border-warning/20 bg-warning-surface text-warning-foreground",
	info: "border-info/20 bg-info/10 text-info-foreground",
}

export type AlertProps = React.HTMLAttributes<HTMLDivElement> & {
	variant?: AlertVariant
}

export const Alert = ({ className, variant = "info", ...props }: AlertProps) => (
	<div
		role="alert"
		className={cn(
			"rounded-[var(--radius)] border px-4 py-3 text-sm",
			VARIANT_CLASSES[variant],
			className,
		)}
		{...props}
	/>
)
