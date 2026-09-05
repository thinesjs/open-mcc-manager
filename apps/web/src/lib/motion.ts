export const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)"

export type MotionVariant = {
	opacity: number
	scale?: number
	filter?: string
}

export const ENTER: MotionVariant = { opacity: 1, scale: 1, filter: "blur(0px)" }

export const EXIT: MotionVariant = { opacity: 0, scale: 0.6, filter: "blur(2px)" }

export const ENTER_REDUCED: MotionVariant = { opacity: 1 }

export const EXIT_REDUCED: MotionVariant = { opacity: 0 }

export const variantsFor = (reduced: boolean): { hidden: MotionVariant; visible: MotionVariant } =>
	reduced ? { hidden: EXIT_REDUCED, visible: ENTER_REDUCED } : { hidden: EXIT, visible: ENTER }

export const durationFor = (reduced: boolean, normal: number): number =>
	reduced ? Math.min(normal, 0.1) : normal
