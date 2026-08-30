import { Kysely, PostgresDialect, type Transaction } from "kysely"
import { Pool } from "pg"
import type { Database } from "./database"

export const createDb = (url: string): Kysely<Database> =>
	new Kysely<Database>({
		dialect: new PostgresDialect({
			pool: new Pool({ connectionString: url, max: 10 }),
		}),
	})

export type Db = Kysely<Database>
export type Tx = Transaction<Database>
export type Executor = Db | Tx
