import type * as React from "react"
import { cn } from "~/lib/utils"

export type LabelProps = React.LabelHTMLAttributes<HTMLLabelElement>

export const Label = ({ className, htmlFor, children, ...props }: LabelProps) => (
	<label
		htmlFor={htmlFor}
		className={cn("text-sm font-medium text-foreground", className)}
		{...props}
	>
		{children}
	</label>
)
