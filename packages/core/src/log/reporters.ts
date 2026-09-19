import { redactError } from "../security/redact"
import type { Logger } from "./logger"

export type RuntimeErrorReporter = (message: string, error: Error | string) => void

export const runtimeErrorReporter =
	(logger: Pick<Logger, "error">): RuntimeErrorReporter =>
	(message, error) =>
		logger.error(message, { detail: error instanceof Error ? redactError(error) : error })

export type RetentionSweepReporter = (removed: number) => void

export const retentionSweepReporter =
	(logger: Pick<Logger, "info">): RetentionSweepReporter =>
	(removed) => {
		if (removed > 0) logger.info(`Removed ${removed} notifications past retention`)
	}

export type RetentionSweep = () => Promise<void>

export const retentionSweepJob =
	(sweep: () => Promise<number>, report: RetentionSweepReporter): RetentionSweep =>
	async () =>
		report(await sweep())

export type LockLostHandler = () => void

export const lockLostHandler =
	(logger: Pick<Logger, "error">, close: () => void, exit: () => void): LockLostHandler =>
	() => {
		logger.error("Singleton lock lost; quiescing and exiting")
		close()
		exit()
	}
