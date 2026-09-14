export type LiveQuery<T> = { data: T | undefined; isError: boolean }

export const liveReading = <T>(query: LiveQuery<T>, on: boolean): T | undefined =>
	on && !query.isError ? query.data : undefined
