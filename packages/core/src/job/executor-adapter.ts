import { type SqlRunner, asSqlRunner as toRunner } from "@open-mcc/contracts/boundary/sql-runner"
import type { Executor } from "@open-mcc/db"
import { CompiledQuery } from "kysely"

export type { SqlRunner }

export const asSqlRunner = (executor: Executor): SqlRunner =>
	toRunner(async (text, values) => {
		const result = await executor.executeQuery(CompiledQuery.raw(text, values))
		return { rows: [...result.rows] }
	})
