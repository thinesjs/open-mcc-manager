export const BOTTOM_THRESHOLD_PX = 24

export type ScrollMetrics = {
	scrollTop: number
	scrollHeight: number
	clientHeight: number
}

export const distanceFromBottom = (metrics: ScrollMetrics): number =>
	metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight

export const isAtBottom = (
	metrics: ScrollMetrics,
	threshold: number = BOTTOM_THRESHOLD_PX,
): boolean => distanceFromBottom(metrics) <= threshold
