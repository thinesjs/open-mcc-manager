import { cn } from "./utils"

const SIDEBAR_BASE =
	"fixed inset-y-0 left-0 z-40 flex h-full w-60 shrink-0 flex-col justify-between overflow-y-auto border-r border-sidebar-border bg-sidebar text-sidebar-foreground outline-none motion-reduce:transition-none lg:visible lg:static lg:translate-x-0"

export const sidebarClasses = (open: boolean): string =>
	cn(
		SIDEBAR_BASE,
		open
			? "visible translate-x-0 transition-transform"
			: "invisible -translate-x-full transition-[transform,visibility]",
	)
