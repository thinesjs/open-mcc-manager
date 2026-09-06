import { Tabs as TabsPrimitive } from "@base-ui/react/tabs"
import { cn } from "~/lib/utils"

const Tabs = TabsPrimitive.Root

const TabsList = ({ className, ...props }: TabsPrimitive.List.Props) => (
	<TabsPrimitive.List
		className={cn("relative flex flex-wrap items-center gap-1 border-border border-b", className)}
		data-slot="tabs-list"
		{...props}
	/>
)

const TabsTab = ({ className, ...props }: TabsPrimitive.Tab.Props) => (
	<TabsPrimitive.Tab
		className={cn(
			"-mb-px cursor-pointer select-none border-transparent border-b-2 px-3 py-2 text-muted-foreground text-sm outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring aria-selected:border-primary aria-selected:font-medium aria-selected:text-foreground",
			className,
		)}
		data-slot="tabs-tab"
		{...props}
	/>
)

const TabsPanel = ({ className, ...props }: TabsPrimitive.Panel.Props) => (
	<TabsPrimitive.Panel
		className={cn("space-y-4 pt-4 outline-none", className)}
		data-slot="tabs-panel"
		{...props}
	/>
)

export { Tabs, TabsList, TabsPanel, TabsTab }
