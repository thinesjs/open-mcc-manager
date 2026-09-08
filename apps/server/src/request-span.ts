import { inRequestSpan } from "@open-mcc/core"
import type { Context, MiddlewareHandler } from "hono"

const UNSPANNED = "/healthz"

const WILDCARDS = ["*", "/*"]

const endpointRoute = (c: Context): string | undefined => {
	const matched = c.req.routePath
	return WILDCARDS.includes(matched) ? undefined : matched
}

export const requestSpan = (): MiddlewareHandler => async (c, next) => {
	if (c.req.path === UNSPANNED) return await next()
	await inRequestSpan(c.req.method, async () => {
		await next()
		return { route: endpointRoute(c), status: c.res.status }
	})
}
