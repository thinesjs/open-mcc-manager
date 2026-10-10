export class InstanceTaskStepsFailedError extends Error {
	readonly stepsSent: number

	constructor(message: string, stepsSent: number) {
		super(message)
		this.stepsSent = stepsSent
	}
}

export type TaskStep = {
	position: number
	command: string
}

export type TaskStepRunner = {
	send: (command: string) => Promise<void>
	wait: (milliseconds: number) => Promise<void>
	describeFailure: (error: Error | string) => string
}

const UNKNOWN_FAILURE = "The step could not be sent"

export const sendStepsInOrder = async (
	steps: readonly TaskStep[],
	stepDelaySeconds: number,
	runner: TaskStepRunner,
): Promise<number> => {
	const ordered = [...steps].sort((left, right) => left.position - right.position)
	let sent = 0

	for (const [index, step] of ordered.entries()) {
		if (index > 0 && stepDelaySeconds > 0) await runner.wait(stepDelaySeconds * 1000)
		try {
			await runner.send(step.command)
		} catch (error) {
			throw new InstanceTaskStepsFailedError(
				`Step ${index + 1} of ${ordered.length} failed and the rest were not sent: ${runner.describeFailure(
					error instanceof Error ? error : UNKNOWN_FAILURE,
				)}`,
				sent,
			)
		}
		sent += 1
	}

	return sent
}
