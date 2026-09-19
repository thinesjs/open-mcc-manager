export type StepDirection = 1 | -1

export const clampStep = (next: number, total: number): number =>
	Math.max(0, Math.min(total - 1, next))

export const directionBetween = (from: number, to: number): StepDirection => (to >= from ? 1 : -1)

export const isLastStep = (step: number, total: number): boolean => step === total - 1
