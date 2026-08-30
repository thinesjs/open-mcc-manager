import { cva, type VariantProps } from "class-variance-authority"
import type * as React from "react"
import { cn } from "~/lib/utils"

const alertVariants = cva("relative rounded-xl border px-3.5 py-3 text-card-foreground text-sm", {
	defaultVariants: {
		variant: "default",
	},
	variants: {
		variant: {
			default: "bg-transparent dark:bg-input/32 [&_svg]:text-muted-foreground",
			error:
				"border-error/32 bg-error-surface text-error-foreground [&_[data-slot=alert-description]]:text-error-foreground/80 [&_svg]:text-error",
			info: "border-info/32 bg-info/4 [&_svg]:text-info",
			success: "border-success/32 bg-success/4 [&_svg]:text-success",
			warning:
				"border-warning/32 bg-warning-surface text-warning-foreground [&_[data-slot=alert-description]]:text-warning-foreground/80 [&_svg]:text-warning",
		},
	},
})

type AlertProps = React.ComponentProps<"div"> &
	VariantProps<typeof alertVariants> & {
		controlAlignment?: "center" | "first-line"
		icon?: React.ReactNode
		action?: React.ReactNode
	}

function Alert({
	className,
	variant,
	controlAlignment = "center",
	icon,
	action,
	children,
	...props
}: AlertProps) {
	return (
		<div
			className={cn(alertVariants({ variant }), className)}
			data-slot="alert"
			role="alert"
			{...props}
		>
			<div
				className={cn(
					"flex gap-2",
					controlAlignment === "first-line" ? "items-start" : "items-center",
					controlAlignment === "first-line" && action && "min-h-7 pt-1 sm:min-h-6 sm:pt-0.5",
				)}
			>
				{icon ? (
					<div
						className={cn(
							"flex shrink-0 items-center justify-center",
							controlAlignment === "first-line"
								? "h-lh w-4 [&>svg]:size-4"
								: "size-4 [&>svg]:size-full",
						)}
					>
						{icon}
					</div>
				) : null}
				{children ? <div className="flex min-w-0 flex-1 flex-col gap-0.5">{children}</div> : null}
				{action ? (
					<div
						className={cn(
							"flex shrink-0 items-center",
							controlAlignment === "first-line" ? "h-lh self-start" : "self-center",
						)}
					>
						{action}
					</div>
				) : null}
			</div>
		</div>
	)
}

function AlertTitle({ className, ...props }: React.ComponentProps<"div">) {
	return <div className={cn("font-medium", className)} data-slot="alert-title" {...props} />
}

function AlertDescription({ className, ...props }: React.ComponentProps<"div">) {
	return (
		<div
			className={cn("flex flex-col gap-2.5 text-muted-foreground", className)}
			data-slot="alert-description"
			{...props}
		/>
	)
}

function AlertAction({ className, ...props }: React.ComponentProps<"div">) {
	return <div className={cn("flex gap-1", className)} data-slot="alert-action" {...props} />
}

export { Alert, AlertAction, AlertDescription, type AlertProps, AlertTitle, alertVariants }
