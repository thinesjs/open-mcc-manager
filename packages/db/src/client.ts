import { type Dialect, Kysely, PostgresDialect, type Transaction } from "kysely"
import { Pool } from "pg"
import type { Database } from "./database"

type DecorateDialect = (dialect: Dialect) => Dialect

const asItComes: DecorateDialect = (dialect) => dialect

export const createDb = (url: string, decorate: DecorateDialect = asItComes): Kysely<Database> =>
	new Kysely<Database>({
		dialect: decorate(
			new PostgresDialect({
				pool: new Pool({ connectionString: url, max: 10 }),
			}),
		),
	})

export type Db = Kysely<Database>
export type Tx = Transaction<Database>
export type Executor = Db | Tx
