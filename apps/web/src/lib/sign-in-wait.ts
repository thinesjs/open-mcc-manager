export const SIGN_IN_CHECK_INTERVAL_MS = 5_000

export const SIGN_IN_WAIT_WINDOW_MS = 120_000

export type SignInWait = {
	until: number
	checks: number
	ended: boolean
}

export const noteSignInNotYet = (current: SignInWait | undefined, now: number): SignInWait =>
	current === undefined
		? { until: now + SIGN_IN_WAIT_WINDOW_MS, checks: 1, ended: false }
		: { ...current, checks: current.checks + 1 }

export const endSignInWait = (current: SignInWait | undefined): SignInWait | undefined =>
	current === undefined ? undefined : { ...current, ended: true }

export const describeSignInWaitWindow = (): string => {
	const minutes = SIGN_IN_WAIT_WINDOW_MS / 60_000
	return `${minutes} minute${minutes === 1 ? "" : "s"}`
}
