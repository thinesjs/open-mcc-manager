import {
	inventoryItemTotal,
	inventorySections,
	type McpInventorySlot,
} from "@open-mcc/contracts/boundary/mcp"

export type LiveInventoryView = {
	id: number
	slots: readonly McpInventorySlot[]
	cursor?: { label: string; count: number } | undefined
}

export type LiveInventoryProps = {
	inventory: LiveInventoryView
}

export const LiveInventory = ({ inventory }: LiveInventoryProps) => {
	const sections = inventorySections(inventory)

	if (sections.length === 0) {
		return <p className="text-sm text-muted-foreground">Carrying nothing.</p>
	}

	return (
		<div className="space-y-3">
			{sections.map((section) => (
				<div key={section.name} className="space-y-1">
					<h4 className="text-[0.6875rem] font-semibold uppercase tracking-wider text-muted-foreground">
						{section.name}
					</h4>
					<ul className="grid gap-x-8 gap-y-1 text-xs sm:grid-cols-2">
						{section.slots.map((slot) => (
							<li key={slot.slot} className="flex justify-between gap-4">
								<span className="text-foreground">{slot.label}</span>
								<span className="tabular-nums text-muted-foreground">{slot.count}</span>
							</li>
						))}
					</ul>
				</div>
			))}
			<p className="text-xs text-muted-foreground">
				{inventoryItemTotal(inventory)} items across {inventory.slots.length} slots
				{inventory.cursor ? ` · holding ${inventory.cursor.count} × ${inventory.cursor.label}` : ""}
			</p>
		</div>
	)
}
