import { destinationStoredConfig, type StoredDestinationConfig } from "../notification"

export const readDestinationConfig = (
	kind: string,
	sealed: string,
): StoredDestinationConfig | undefined => {
	let decoded: unknown
	try {
		decoded = JSON.parse(sealed)
	} catch {
		return undefined
	}
	const parsed = destinationStoredConfig.safeParse({ kind, config: decoded })
	return parsed.success ? parsed.data : undefined
}
