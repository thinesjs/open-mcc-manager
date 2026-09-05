import type { LucideIcon } from "lucide-react"
import type { ReactNode } from "react"

export type EmptyStateProps = {
	icon: LucideIcon
	title: string
	description: string
	action?: ReactNode
	compact?: boolean
}

export const EmptyState = ({
	icon: Icon,
	title,
	description,
	action,
	compact = false,
}: EmptyStateProps) => (
	<div
		className={
			compact
				? "flex flex-col items-center justify-center px-6 py-10 text-center"
				: "flex flex-col items-center justify-center px-6 py-20 text-center"
		}
	>
		<Icon className="mb-4 size-6 text-muted-foreground/60" strokeWidth={1.5} />
		<p className="text-sm font-medium text-foreground">{title}</p>
		<p className="mt-1 max-w-sm text-sm text-muted-foreground">{description}</p>
		{action ? <div className="mt-5">{action}</div> : null}
	</div>
)
