import { SpanStatusCode, trace } from "@opentelemetry/api"

const PROCEDURE_TRACER = "open-mcc/procedure"

export const inProcedureSpan = async <T extends { readonly ok: boolean }>(
	type: string,
	path: string,
	run: () => Promise<T>,
): Promise<T> =>
	await trace
		.getTracer(PROCEDURE_TRACER)
		.startActiveSpan(
			`${type} ${path}`,
			{ attributes: { "rpc.system": "trpc", "rpc.method": path } },
			async (span) => {
				try {
					const result = await run()
					if (!result.ok) span.setStatus({ code: SpanStatusCode.ERROR })
					return result
				} catch (error) {
					span.setStatus({ code: SpanStatusCode.ERROR })
					throw error
				} finally {
					span.end()
				}
			},
		)
