export type SqlRunner = {
	executeSql: (text: string, values?: unknown[]) => Promise<{ rows: unknown[] }>
}

export type RunQuery = (text: string, values: unknown[]) => Promise<{ rows: unknown[] }>

export const asSqlRunner = (run: RunQuery): SqlRunner => ({
	executeSql: async (text, values) => run(text, values === undefined ? [] : values),
})
