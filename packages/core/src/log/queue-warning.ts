import type { PgBoss, Warning } from "pg-boss"
import type { Logger } from "./logger"

export type QueueWarningListener = (warning: Warning) => void

export const attachQueueWarning = (boss: PgBoss, logger: Logger): QueueWarningListener => {
	const listener: QueueWarningListener = (warning) => logger.warn(warning.message)
	boss.on("warning", listener)
	return listener
}
