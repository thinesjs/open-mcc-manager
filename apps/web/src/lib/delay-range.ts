import type { DelaySecondsRange } from "@open-mcc/contracts"

export const formatDelaySeconds = (range: DelaySecondsRange): string =>
	range.min === range.max ? `${range.min}s` : `${range.min}-${range.max}s`
