import {
	type Context,
	context,
	isSpanContextValid,
	propagation,
	ROOT_CONTEXT,
	trace,
} from "@opentelemetry/api"
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks"
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http"
import { resourceFromAttributes } from "@opentelemetry/resources"
import { BatchSpanProcessor, NodeTracerProvider } from "@opentelemetry/sdk-trace-node"
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions"
import type { TraceIds } from "./logger"

export const TRACES_PATH = "/v1/traces"

export type TracingHandle = {
	readonly active: boolean
	readonly shutdown: () => Promise<void>
}

export type TracingOptions = {
	readonly service: string
	readonly version?: string
	readonly endpoint?: string
}

export const tracesUrl = (endpoint: string): string =>
	`${endpoint.trim().replace(/\/+$/, "")}${TRACES_PATH}`

const dormant: TracingHandle = { active: false, shutdown: async () => undefined }

export const startTracing = (options: TracingOptions): TracingHandle => {
	const endpoint = options.endpoint?.trim() ?? ""
	if (endpoint.length === 0) return dormant

	const provider = new NodeTracerProvider({
		resource: resourceFromAttributes({
			[ATTR_SERVICE_NAME]: options.service,
			...(options.version === undefined ? {} : { [ATTR_SERVICE_VERSION]: options.version }),
		}),
		spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter({ url: tracesUrl(endpoint) }))],
	})

	provider.register({ contextManager: new AsyncLocalStorageContextManager().enable() })

	return { active: true, shutdown: () => provider.shutdown().catch(() => undefined) }
}

export const activeTraceIds = (): TraceIds | undefined => {
	const span = trace.getActiveSpan()
	if (span === undefined) return undefined
	const spanContext = span.spanContext()
	if (!isSpanContextValid(spanContext)) return undefined
	return { trace_id: spanContext.traceId, span_id: spanContext.spanId }
}

export const TRACEPARENT = "traceparent"

export const carrierForActiveContext = (): Record<string, string> => {
	const carrier: Record<string, string> = {}
	propagation.inject(context.active(), carrier)
	return carrier
}

export const contextFromCarrier = (carrier: Readonly<Record<string, string>>): Context =>
	propagation.extract(ROOT_CONTEXT, carrier)

export const hasTraceparent = (carrier: Readonly<Record<string, string>>): boolean => {
	const value = carrier[TRACEPARENT]
	return typeof value === "string" && value.length > 0
}
