import {
	inventoryItemTotal,
	itemSlug,
	type McpInventorySlot,
	regionsFor,
	slotsBySlotNumber,
} from "@open-mcc/contracts/boundary/mcp"
import { useState } from "react"

export type LiveInventoryView = {
	id: number
	slotCount: number
	slots: readonly McpInventorySlot[]
	cursor?: { label: string; count: number } | undefined
}

export type LiveInventoryProps = {
	inventory: LiveInventoryView
}

const PANEL = "#c6c6c6"
const SLOT = "#8b8b8b"
const SHADOW = "#373737"
const HIGHLIGHT = "#ffffff"
const PANEL_SHADOW = "#555555"

const ItemIcon = ({ item }: { item: McpInventorySlot }) => {
	const [missing, setMissing] = useState(false)
	if (missing) {
		return (
			<span className="px-0.5 text-center text-[8px] leading-[1.05] text-[#3f3f3f]">
				{item.label}
			</span>
		)
	}
	return (
		<img
			src={`/api/item-icons/${itemSlug(item.label)}`}
			alt=""
			width={32}
			height={32}
			loading="lazy"
			onError={() => setMissing(true)}
			className="size-8 [image-rendering:pixelated]"
		/>
	)
}

const Slot = ({ item }: { item: McpInventorySlot | undefined }) => (
	<div
		className="relative grid size-11 place-items-center"
		style={{
			backgroundColor: SLOT,
			borderTop: `2px solid ${SHADOW}`,
			borderLeft: `2px solid ${SHADOW}`,
			borderBottom: `2px solid ${HIGHLIGHT}`,
			borderRight: `2px solid ${HIGHLIGHT}`,
		}}
		title={item ? `${item.label} × ${item.count}` : undefined}
	>
		{item ? (
			<>
				<ItemIcon item={item} />
				{item.count > 1 ? (
					<span
						className="absolute right-0 bottom-0 font-mono text-[11px] leading-none text-white"
						style={{ textShadow: "1px 1px 0 #3f3f3f" }}
					>
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
			<div
				className="inline-block w-max p-3"
				style={{
					backgroundColor: PANEL,
					borderTop: `3px solid ${HIGHLIGHT}`,
					borderLeft: `3px solid ${HIGHLIGHT}`,
					borderBottom: `3px solid ${PANEL_SHADOW}`,
					borderRight: `3px solid ${PANEL_SHADOW}`,
					outline: "2px solid #000000",
				}}
			>
				<div className="flex flex-wrap items-start gap-x-5 gap-y-3">
					{regions.map((region) => (
						<div key={region.name} className="space-y-1">
							<h4
								className="text-[10px] font-semibold uppercase tracking-wider"
								style={{ color: "#3f3f3f" }}
							>
								{region.name}
							</h4>
							<div
								className="grid w-max gap-0.5"
								style={{ gridTemplateColumns: `repeat(${region.columns}, 2.75rem)` }}
							>
								{region.slots.map((slot) => (
									<Slot key={slot} item={byNumber.get(slot)} />
								))}
							</div>
						</div>
					))}
				</div>
			</div>

			<p className="text-xs text-muted-foreground">
				{inventoryItemTotal(inventory)} items across {inventory.slots.length} slots
				{inventory.cursor ? ` · holding ${inventory.cursor.count} × ${inventory.cursor.label}` : ""}
			</p>
		</div>
	)
}
