import { ContextMenu as Base } from "@base-ui/react/context-menu"
import type { ReactElement, ReactNode } from "react"
import { cn } from "~/lib/utils"

export type ContextMenuProps = {
	items: ReactNode
	children: ReactNode
	className?: string | undefined
	render?: ReactElement | undefined
}

export const ContextMenu = ({ items, children, className, render }: ContextMenuProps) => (
	<Base.Root>
		<Base.Trigger className={className} render={render ?? <div />}>
			{children}
		</Base.Trigger>
		<Base.Portal>
			<Base.Positioner className="z-50">
				<Base.Popup className="dropdown-glass min-w-52 origin-[var(--transform-origin)] rounded-[var(--radius)] border border-border p-1 text-sm text-foreground shadow-lg transition-[opacity,transform] duration-150 ease-out data-[ending-style]:scale-[0.98] data-[ending-style]:opacity-0 data-[starting-style]:scale-[0.98] data-[starting-style]:opacity-0 motion-reduce:transition-none">
					{items}
				</Base.Popup>
			</Base.Positioner>
		</Base.Portal>
	</Base.Root>
)

export type ContextMenuItemProps = {
	onClick: () => void
	children: ReactNode
	destructive?: boolean
	disabled?: boolean
}

export const ContextMenuItem = ({
	onClick,
	children,
	destructive = false,
	disabled = false,
}: ContextMenuItemProps) => (
	<Base.Item
		disabled={disabled}
		onClick={onClick}
		className={cn(
			"flex cursor-default select-none items-center gap-2 rounded-[var(--control-radius)] px-2.5 py-1.5 outline-none data-[highlighted]:bg-accent",
			destructive ? "text-destructive data-[highlighted]:text-destructive" : "text-foreground",
			disabled ? "pointer-events-none opacity-50" : "",
		)}
	>
		{children}
	</Base.Item>
)

export const ContextMenuSeparator = () => <Base.Separator className="my-1 h-px bg-border" />

export const ContextMenuGroupLabel = ({ children }: { children: ReactNode }) => (
	<Base.GroupLabel className="px-2.5 py-1 text-[0.6875rem] font-semibold uppercase tracking-wider text-muted-foreground">
		{children}
	</Base.GroupLabel>
)
