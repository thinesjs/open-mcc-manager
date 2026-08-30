import { createMiddleware } from "hono/factory"

const CSP = [
	"default-src 'self'",
	"script-src 'self'",
	"style-src 'self'",
	"img-src 'self' data:",
	"connect-src 'self' ws: wss:",
	"frame-ancestors 'none'",
	"base-uri 'self'",
	"form-action 'self'",
	"object-src 'none'",
].join("; ")

const HEADERS: ReadonlyArray<readonly [string, string]> = [
	["Strict-Transport-Security", "max-age=63072000; includeSubDomains; preload"],
	["Content-Security-Policy", CSP],
	["X-Content-Type-Options", "nosniff"],
	["Referrer-Policy", "no-referrer"],
	["Permissions-Policy", "camera=(), microphone=(), geolocation=(), interest-cohort=()"],
	["Cross-Origin-Opener-Policy", "same-origin"],
	["Cross-Origin-Resource-Policy", "same-origin"],
	["X-Frame-Options", "DENY"],
]

export const securityHeaders = () =>
	createMiddleware(async (c, next) => {
		await next()
		for (const [name, value] of HEADERS) c.header(name, value)
		c.res.headers.delete("X-Powered-By")
	})
