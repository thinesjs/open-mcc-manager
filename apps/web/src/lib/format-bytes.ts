const UNITS = ["B", "KB", "MB", "GB", "TB"] as const

export const formatBytes = (bytes: number): string => {
	if (!Number.isFinite(bytes) || bytes < 0) return "—"
	let value = bytes
	let unit = 0
	while (value >= 1024 && unit < UNITS.length - 1) {
		value /= 1024
		unit += 1
	}
	const decimals = unit === 0 || value >= 100 ? 0 : 1
	return `${value.toFixed(decimals)} ${UNITS[unit]}`
}

export const formatMegabytes = (megabytes: number): string => formatBytes(megabytes * 1024 * 1024)

export const formatDuration = (seconds: number): string => {
	if (!Number.isFinite(seconds) || seconds < 0) return "—"
	const days = Math.floor(seconds / 86400)
	const hours = Math.floor((seconds % 86400) / 3600)
	const minutes = Math.floor((seconds % 3600) / 60)
	if (days > 0) return `${days}d ${hours}h`
	if (hours > 0) return `${hours}h ${minutes}m`
	return `${minutes}m`
}

export const percentOf = (used: number, total: number): number =>
	total > 0 ? Math.min(100, Math.round((used / total) * 100)) : 0
