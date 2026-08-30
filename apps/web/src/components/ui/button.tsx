import type * as React from "react"
import { cn } from "~/lib/utils"

export type ButtonVariant = "default" | "outline" | "ghost" | "destructive"
export type ButtonSize = "default" | "sm" | "icon"

const BASE_CLASSES =
	"inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-[var(--control-radius)] font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50"

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
	default: "bg-primary text-primary-foreground hover:bg-primary/90",
	outline: "border border-input bg-popover text-foreground hover:bg-accent",
	ghost: "text-foreground hover:bg-accent",
	destructive: "bg-destructive text-destructive-foreground hover:bg-destructive/90",
}

const SIZE_CLASSES: Record<ButtonSize, string> = {
	default: "h-9 px-4 text-sm",
	sm: "h-8 px-3 text-sm",
	icon: "size-9",
}

export type ButtonVariantOptions = {
	variant?: ButtonVariant | undefined
	size?: ButtonSize | undefined
	className?: string | undefined
}

export const buttonVariants = ({
	variant = "default",
	size = "default",
	className,
}: ButtonVariantOptions = {}): string =>
	cn(BASE_CLASSES, VARIANT_CLASSES[variant], SIZE_CLASSES[size], className)

export type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
	variant?: ButtonVariant
	size?: ButtonSize
}

export const Button = ({ className, variant, size, type = "button", ...props }: ButtonProps) => (
	<button type={type} className={buttonVariants({ variant, size, className })} {...props} />
)
