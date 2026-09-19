import { createMiddleware } from "hono/factory"

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"])

export const assertNoWildcard = (allowed: string[]): void => {
	if (allowed.includes("*")) {
		throw new Error("ALLOWED_ORIGINS must not contain '*' when credentials are enabled")
	}
}

export const strictCors = (allowed: string[]) => {
	assertNoWildcard(allowed)
	return createMiddleware(async (c, next) => {
		const origin = c.req.header("Origin")
		await next()
		if (origin && allowed.includes(origin)) {
			c.header("Access-Control-Allow-Origin", origin)
			c.header("Access-Control-Allow-Credentials", "true")
			c.header("Access-Control-Allow-Headers", "content-type")
			c.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
			c.header("Vary", "Origin")
		}
	})
}

export const requireSameOrigin = (allowed: string[]) =>
	createMiddleware(async (c, next) => {
		if (SAFE_METHODS.has(c.req.method)) return next()
		const origin = c.req.header("Origin")
		if (!origin || !allowed.includes(origin)) {
			return c.json({ error: "Origin not allowed" }, 403)
		}
		return next()
	})
