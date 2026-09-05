import { cn } from "~/lib/utils"

export type SpinnerProps = {
	label: string
	className?: string
}

export const Spinner = ({ label, className }: SpinnerProps) => (
	<>
		<svg
			role="img"
			aria-label={label}
			viewBox="0 0 24 24"
			className={cn("size-4 shrink-0 animate-spin motion-reduce:animate-none", className)}
		>
			<title>{label}</title>
			<circle
				cx="12"
				cy="12"
				r="9"
				fill="none"
				stroke="currentColor"
				strokeOpacity="0.2"
				strokeWidth="2.5"
			/>
			<path
				d="M21 12a9 9 0 0 0-9-9"
				fill="none"
				stroke="currentColor"
				strokeWidth="2.5"
				strokeLinecap="round"
			/>
		</svg>
	</>
)

export const LoadingBlock = ({ label }: { label: string }) => (
	<div className="flex items-center py-2 text-muted-foreground" role="status">
		<Spinner label={label} />
	</div>
)
