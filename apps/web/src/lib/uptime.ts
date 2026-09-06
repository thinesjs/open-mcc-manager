import { type Availability, coverageRatio, uptimeRatio } from "@open-mcc/contracts"

export const formatPercent = (ratio: number): string => {
	const percent = ratio * 100
	if (percent >= 99.95) return "100%"
	if (percent >= 99.5) return `${percent.toFixed(2)}%`
	return `${percent.toFixed(1)}%`
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
