import {
	type Attributes,
	context as activeContext,
	type Span,
	SpanKind,
	SpanStatusCode,
	trace,
} from "@opentelemetry/api"
import { contextFromCarrier, hasTraceparent } from "./tracing"

const JOB_TRACER = "open-mcc/job"

type Carrier = Readonly<Record<string, string>>

const parentOf = (carrier: Carrier) =>
	hasTraceparent(carrier) ? contextFromCarrier(carrier) : activeContext.active()

export const inCarriedSpan = async <T>(
	name: string,
	carrier: Carrier,
	attributes: Attributes,
	fn: (span: Span) => Promise<T>,
): Promise<T> =>
	await trace
		.getTracer(JOB_TRACER)
		.startActiveSpan(
			name,
			{ attributes, kind: SpanKind.CONSUMER },
			parentOf(carrier),
			async (span: Span) => {
				try {
					return await fn(span)
				} catch (error) {
					span.setStatus({ code: SpanStatusCode.ERROR })
					throw error
				} finally {
					span.end()
				}
			},
		)
