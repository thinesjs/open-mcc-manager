import {
	inventoryItemTotal,
	itemSlug,
	type McpInventorySlot,
	regionsFor,
	slotsBySlotNumber,
} from "@open-mcc/contracts/boundary/mcp"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { ContextMenu, ContextMenuItem, ContextMenuSeparator } from "~/components/ui/context-menu"
import { useTRPC } from "~/lib/trpc"

export type LiveInventoryView = {
	id: number
	slotCount: number
	slots: readonly McpInventorySlot[]
	cursor?: { label: string; count: number } | undefined
}

export type LiveInventoryProps = {
	inventory: LiveInventoryView
	instanceId: string
	canInteract: boolean
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

const TOOLTIP_BACKGROUND = "rgba(16, 0, 16, 0.94)"
const TOOLTIP_BORDER_TOP = "#5000ff"
const TOOLTIP_BORDER_BOTTOM = "#280050"

const SLOT_CHROME = {
	backgroundColor: SLOT,
	borderTop: `2px solid ${SHADOW}`,
	borderLeft: `2px solid ${SHADOW}`,
	borderBottom: `2px solid ${HIGHLIGHT}`,
	borderRight: `2px solid ${HIGHLIGHT}`,
} as const

export type SlotProps = {
	item: McpInventorySlot | undefined
	onDrop?: ((item: McpInventorySlot, count: number) => void) | undefined
	onHold?: ((item: McpInventorySlot) => void) | undefined
}

const Slot = ({ item, onDrop, onHold }: SlotProps) => {
	if (!item) {
		return <div className="size-11" style={SLOT_CHROME} />
	}

	const face = (
		<div
			role="img"
			aria-label={`${item.label}, ${item.count} in slot ${item.slot}`}
			className="group relative grid size-11 place-items-center"
			style={SLOT_CHROME}
		>
			<ItemIcon item={item} />
			{item.count > 1 ? (
				<span
					className="absolute right-0 bottom-0 font-mono text-[11px] leading-none text-white"
					style={{ textShadow: "1px 1px 0 #3f3f3f" }}
				>
					{item.count}
				</span>
			) : null}
			<span
				className="pointer-events-none absolute bottom-[110%] left-1/2 z-20 hidden w-max -translate-x-1/2 px-2 py-1 group-hover:block"
				style={{
					backgroundColor: TOOLTIP_BACKGROUND,
					borderTop: `2px solid ${TOOLTIP_BORDER_TOP}`,
					borderLeft: `2px solid ${TOOLTIP_BORDER_TOP}`,
					borderBottom: `2px solid ${TOOLTIP_BORDER_BOTTOM}`,
					borderRight: `2px solid ${TOOLTIP_BORDER_BOTTOM}`,
				}}
			>
				<span className="block whitespace-nowrap text-[11px] leading-tight text-white">
					{item.label}
				</span>
				<span className="block whitespace-nowrap text-[10px] leading-tight text-[#aaaaaa]">
					{item.count === 1 ? `Slot ${item.slot}` : `${item.count} · slot ${item.slot}`}
				</span>
			</span>
		</div>
	)

	if (onDrop === undefined || onHold === undefined) return face

	return (
		<ContextMenu
			items={
				<>
					<ContextMenuItem onClick={() => onHold(item)}>Hold this</ContextMenuItem>
					<ContextMenuSeparator />
					<ContextMenuItem destructive onClick={() => onDrop(item, 1)}>
						Drop one
					</ContextMenuItem>
					{item.count > 1 ? (
						<ContextMenuItem destructive onClick={() => onDrop(item, item.count)}>
							Drop all {item.count}
						</ContextMenuItem>
					) : null}
				</>
			}
		>
			{face}
		</ContextMenu>
	)
}

export const LiveInventory = ({ inventory, instanceId, canInteract }: LiveInventoryProps) => {
	const trpc = useTRPC()
	const queryClient = useQueryClient()
	const refresh = { onSuccess: () => queryClient.invalidateQueries() }
	const dropMutation = useMutation(trpc.instance.dropInventoryItem.mutationOptions(refresh))
	const holdMutation = useMutation(trpc.instance.selectHeldItem.mutationOptions(refresh))
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
									<Slot
										key={slot}
										item={byNumber.get(slot)}
										{...(canInteract
											? {
													onDrop: (item, count) =>
														dropMutation.mutate({ instanceId, itemType: item.type, count }),
													onHold: (item) =>
														holdMutation.mutate({ instanceId, itemType: item.type }),
												}
											: {})}
									/>
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
