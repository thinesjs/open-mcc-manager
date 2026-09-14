import { type Availability, coverageRatio, uptimeRatio } from "@open-mcc/contracts"

export const formatPercent = (ratio: number): string => {
	if (ratio === 1) return "100%"
	const hundredths = Math.min(9_999, Math.floor(ratio * 10_000 + 1e-9))
	return `${(hundredths / 100).toFixed(2)}%`
}

export const describeUptime = (availability: Availability): string => {
	const ratio = uptimeRatio(availability)
	return ratio === undefined ? "Not measured yet" : formatPercent(ratio)
}

export const describeCoverage = (availability: Availability): string | undefined => {
	const ratio = coverageRatio(availability)
	if (ratio === undefined) return undefined
	if (ratio >= 0.999) return undefined
	return `Measured ${formatPercent(ratio)} of the time`
}
