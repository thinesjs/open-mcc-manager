export type TrackedStateConfig = {
	worldDataEnabled: boolean
	inventoryDataEnabled: boolean
	entityDataEnabled: boolean
}

export const trackedStateSummary = (config: TrackedStateConfig): string => {
	const tracked = [
		config.worldDataEnabled ? "World" : undefined,
		config.inventoryDataEnabled ? "Inventory" : undefined,
		config.entityDataEnabled ? "Entities" : undefined,
	].filter((name): name is string => name !== undefined)
	return tracked.length === 0 ? "Nothing" : tracked.join(", ")
}
