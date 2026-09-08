import { SpanKind, SpanStatusCode, trace } from "@opentelemetry/api"
import {
	ATTR_HTTP_REQUEST_METHOD,
	ATTR_HTTP_REQUEST_METHOD_ORIGINAL,
	ATTR_HTTP_RESPONSE_STATUS_CODE,
	ATTR_HTTP_ROUTE,
	HTTP_REQUEST_METHOD_VALUE_CONNECT,
	HTTP_REQUEST_METHOD_VALUE_DELETE,
	HTTP_REQUEST_METHOD_VALUE_GET,
	HTTP_REQUEST_METHOD_VALUE_HEAD,
	HTTP_REQUEST_METHOD_VALUE_OPTIONS,
	HTTP_REQUEST_METHOD_VALUE_OTHER,
	HTTP_REQUEST_METHOD_VALUE_PATCH,
	HTTP_REQUEST_METHOD_VALUE_POST,
	HTTP_REQUEST_METHOD_VALUE_PUT,
	HTTP_REQUEST_METHOD_VALUE_TRACE,
} from "@opentelemetry/semantic-conventions"

const REQUEST_TRACER = "open-mcc/request"

const SERVER_ERROR = 500

const QUERY_METHOD = "QUERY"

const DEFAULT_KNOWN_METHODS: readonly string[] = [
	HTTP_REQUEST_METHOD_VALUE_CONNECT,
	HTTP_REQUEST_METHOD_VALUE_DELETE,
	HTTP_REQUEST_METHOD_VALUE_GET,
	HTTP_REQUEST_METHOD_VALUE_HEAD,
	HTTP_REQUEST_METHOD_VALUE_OPTIONS,
	HTTP_REQUEST_METHOD_VALUE_PATCH,
	HTTP_REQUEST_METHOD_VALUE_POST,
	HTTP_REQUEST_METHOD_VALUE_PUT,
	HTTP_REQUEST_METHOD_VALUE_TRACE,
	QUERY_METHOD,
]

export const knownMethods = (override: string | undefined): readonly string[] => {
	const listed = (override ?? "")
		.split(",")
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0)
	return listed.length === 0 ? DEFAULT_KNOWN_METHODS : listed
}

const KNOWN_METHODS = knownMethods(process.env.OTEL_INSTRUMENTATION_HTTP_KNOWN_METHODS)

const knownMethod = (method: string): string =>
	KNOWN_METHODS.some((known) => known === method) ? method : HTTP_REQUEST_METHOD_VALUE_OTHER

export type HandledRequest = {
	readonly route: string | undefined
	readonly status: number
}

export const inRequestSpan = async (
	method: string,
	handle: () => Promise<HandledRequest>,
): Promise<void> => {
	const known = knownMethod(method)
	await trace
		.getTracer(REQUEST_TRACER)
		.startActiveSpan(known, { kind: SpanKind.SERVER }, async (span) => {
			try {
				const handled = await handle()
				if (handled.route !== undefined) {
					span.updateName(`${known} ${handled.route}`)
					span.setAttribute(ATTR_HTTP_ROUTE, handled.route)
				}
				span.setAttribute(ATTR_HTTP_REQUEST_METHOD, known)
				if (known !== method) span.setAttribute(ATTR_HTTP_REQUEST_METHOD_ORIGINAL, method)
				span.setAttribute(ATTR_HTTP_RESPONSE_STATUS_CODE, handled.status)
				if (handled.status >= SERVER_ERROR) span.setStatus({ code: SpanStatusCode.ERROR })
			} catch (error) {
				span.setStatus({ code: SpanStatusCode.ERROR })
				throw error
			} finally {
				span.end()
			}
		})
}
