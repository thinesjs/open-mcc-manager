import {
	inventoryItemTotal,
	type McpInventorySlot,
	regionsFor,
	slotsBySlotNumber,
} from "@open-mcc/contracts/boundary/mcp"
import { cn } from "~/lib/utils"

export type LiveInventoryView = {
	id: number
	slotCount: number
	slots: readonly McpInventorySlot[]
	cursor?: { label: string; count: number } | undefined
}

export type LiveInventoryProps = {
	inventory: LiveInventoryView
}

const Slot = ({ item }: { item: McpInventorySlot | undefined }) => (
	<div
		title={item ? `${item.label} × ${item.count}` : undefined}
		className={cn(
			"relative flex aspect-square items-center justify-center rounded-[3px] border p-1 transition-colors",
			item
				? "border-border bg-muted/60 text-foreground"
				: "border-border/40 bg-muted/20 text-transparent",
		)}
	>
		{item ? (
			<>
				<span className="line-clamp-2 text-center text-[0.5625rem] leading-tight">
					{item.label}
				</span>
				{item.count > 1 ? (
					<span className="absolute right-0.5 bottom-0 text-[0.625rem] font-semibold tabular-nums text-foreground drop-shadow-sm">
						{item.count}
					</span>
				) : null}
			</>
		) : null}
	</div>
)

export const LiveInventory = ({ inventory }: LiveInventoryProps) => {
	const byNumber = slotsBySlotNumber(inventory.slots)
	const regions = regionsFor({ id: inventory.id, slotCount: inventory.slotCount })

	return (
		<div className="space-y-3">
			<div className="flex flex-wrap items-start gap-x-6 gap-y-3">
				{regions.map((region) => (
					<div key={region.name} className="space-y-1">
						<h4 className="text-[0.6875rem] font-semibold uppercase tracking-wider text-muted-foreground">
							{region.name}
						</h4>
						<div
							className="grid w-max gap-1"
							style={{ gridTemplateColumns: `repeat(${region.columns}, 2.25rem)` }}
						>
							{region.slots.map((slot) => (
								<Slot key={slot} item={byNumber.get(slot)} />
							))}
						</div>
					</div>
				))}
			</div>
			<p className="text-xs text-muted-foreground">
				{inventoryItemTotal(inventory)} items across {inventory.slots.length} slots
				{inventory.cursor ? ` · holding ${inventory.cursor.count} × ${inventory.cursor.label}` : ""}
			</p>
		</div>
	)
}
