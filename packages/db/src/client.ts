import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"
import * as schema from "./schema/index"

export const createDb = (url: string) => {
	const sql = postgres(url, { max: 10 })
	return drizzle(sql, { schema })
}

export type Db = ReturnType<typeof createDb>
