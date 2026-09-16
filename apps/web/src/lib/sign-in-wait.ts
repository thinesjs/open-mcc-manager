export const SIGN_IN_CHECK_INTERVAL_MS = 5_000

export const SIGN_IN_WAIT_WINDOW_MS = 120_000

export type SignInWait = {
	instanceId: string
	until: number
	checks: number
	ended: boolean
}

export const signInWaitFor = (
	wait: SignInWait | undefined,
	instanceId: string,
): SignInWait | undefined => (wait?.instanceId === instanceId ? wait : undefined)

export const noteSignInNotYet = (
	current: SignInWait | undefined,
	instanceId: string,
	now: number,
): SignInWait => {
	const open = signInWaitFor(current, instanceId)
	if (open === undefined || open.ended) {
		return { instanceId, until: now + SIGN_IN_WAIT_WINDOW_MS, checks: 1, ended: false }
	}
	return { ...open, checks: open.checks + 1 }
}

export const endSignInWait = (current: SignInWait | undefined): SignInWait | undefined =>
	current === undefined ? undefined : { ...current, ended: true }

export const describeSignInWaitWindow = (): string => {
	const minutes = SIGN_IN_WAIT_WINDOW_MS / 60_000
	return `${minutes} minute${minutes === 1 ? "" : "s"}`
}
