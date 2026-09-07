import { SpanKind, SpanStatusCode, trace } from "@opentelemetry/api"
import { ATTR_DB_OPERATION_NAME, ATTR_DB_SYSTEM_NAME } from "@opentelemetry/semantic-conventions"
import type { DatabaseConnection, Dialect, Driver } from "kysely"

const DB_TRACER = "open-mcc/db"

const SPAN_NAME = "db.query"

const EXECUTE_QUERY = "executeQuery"

const POSTGRESQL = "postgresql"

const ACQUIRE_CONNECTION = "acquireConnection"

const operationOf = (kind: string): string => kind.replace(/QueryNode$|Node$/, "")

type ExecuteArgs = Parameters<DatabaseConnection["executeQuery"]>

const forwarded = <T extends object>(target: T, property: string | symbol) => {
	const value = Reflect.get(target, property, target)
	return typeof value === "function" ? value.bind(target) : value
}

const tracedConnection = (connection: DatabaseConnection): DatabaseConnection =>
	new Proxy(connection, {
		get(target, property) {
			if (property !== EXECUTE_QUERY) return forwarded(target, property)

			return async (compiledQuery: ExecuteArgs[0], options: ExecuteArgs[1]) => {
				const span = trace.getTracer(DB_TRACER).startSpan(SPAN_NAME, {
					kind: SpanKind.CLIENT,
					attributes: {
						[ATTR_DB_OPERATION_NAME]: operationOf(compiledQuery.query.kind),
						[ATTR_DB_SYSTEM_NAME]: POSTGRESQL,
					},
				})
				try {
					return await target.executeQuery(compiledQuery, options)
				} catch (error) {
					span.setStatus({ code: SpanStatusCode.ERROR })
					throw error
				} finally {
					span.end()
				}
			}
		},
	})

const tracedDriver = (driver: Driver): Driver =>
	new Proxy(driver, {
		get(target, property) {
			if (property !== ACQUIRE_CONNECTION) return forwarded(target, property)

			return async (options: Parameters<Driver["acquireConnection"]>[0]) =>
				tracedConnection(await target.acquireConnection(options))
		},
	})

export const tracedDialect = (dialect: Dialect): Dialect => ({
	createDriver: () => tracedDriver(dialect.createDriver()),
	createQueryCompiler: () => dialect.createQueryCompiler(),
	createAdapter: () => dialect.createAdapter(),
	createIntrospector: (db) => dialect.createIntrospector(db),
})
