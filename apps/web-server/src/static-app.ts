import { readFile, stat } from "node:fs/promises"
import path from "node:path"
import { Hono } from "hono"
import { createMiddleware } from "hono/factory"
import { getMimeType } from "hono/utils/mime"

const CSP = [
	"default-src 'self'",
	"script-src 'self'",
	"style-src 'self'",
	"img-src 'self' data:",
	"connect-src 'self'",
	"frame-ancestors 'none'",
	"base-uri 'self'",
	"form-action 'self'",
	"object-src 'none'",
].join("; ")

export const DASHBOARD_HEADERS: ReadonlyArray<readonly [string, string]> = [
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
		for (const [name, value] of DASHBOARD_HEADERS) c.header(name, value)
		c.res.headers.delete("X-Powered-By")
	})

export const ASSETS_DIR = "assets"

export const HASHED_ASSETS = `/${ASSETS_DIR}/`

export const IMMUTABLE_CACHE = "public, max-age=31536000, immutable"

export const UNCACHED = "no-store"

const SHELL = "index.html"

const SHELL_TYPE = "text/html; charset=utf-8"

const TEXT_TYPE = "text/plain; charset=utf-8"

const UNKNOWN_TYPE = "application/octet-stream"

const MISSING_DASHBOARD = "The dashboard files are missing from this image."

export const reservedForApi = (pathname: string): boolean =>
	pathname === "/healthz" ||
	pathname === "/trpc" ||
	pathname.startsWith("/trpc/") ||
	pathname === "/api" ||
	pathname.startsWith("/api/")

export const decodedPath = (pathname: string): string | undefined => {
	let decoded = ""
	try {
		decoded = decodeURIComponent(pathname)
	} catch {
		return undefined
	}
	return decoded.includes("\0") ? undefined : decoded
}

export const withinRoot = (root: string, decoded: string): string | undefined => {
	const resolved = path.resolve(root, `.${decoded}`)
	const inside = path.relative(root, resolved)
	return inside.startsWith("..") || path.isAbsolute(inside) ? undefined : resolved
}

const segmentsOf = (within: string): string[] => within.split(path.sep)

export const isHashedAsset = (within: string): boolean => segmentsOf(within)[0] === ASSETS_DIR

export const namesAFile = (within: string): boolean =>
	isHashedAsset(within) || (segmentsOf(within).at(-1) ?? "").includes(".")

export const cacheFor = (within: string): string =>
	isHashedAsset(within) ? IMMUTABLE_CACHE : UNCACHED

const readIfFile = async (file: string): Promise<Buffer | undefined> => {
	try {
		const found = await stat(file)
		if (!found.isFile()) return undefined
		return await readFile(file)
	} catch {
		return undefined
	}
}

const served = (body: Buffer, type: string, cache: string): Response =>
	new Response(body, { headers: { "Content-Type": type, "Cache-Control": cache } })

const missing = (): Response =>
	new Response("Not found", { status: 404, headers: { "Content-Type": TEXT_TYPE } })

export const createStaticApp = (root: string): Hono => {
	const app = new Hono()
	app.use("*", securityHeaders())
	app.on(["GET", "HEAD"], "*", async (c) => {
		const decoded = decodedPath(c.req.path)
		if (decoded === undefined) return missing()
		if (reservedForApi(decoded)) return missing()
		const file = withinRoot(root, decoded)
		if (file === undefined) return missing()
		const within = path.relative(root, file)
		const body = await readIfFile(file)
		if (body !== undefined) {
			return served(body, getMimeType(file) ?? UNKNOWN_TYPE, cacheFor(within))
		}
		if (namesAFile(within)) return missing()
		const shell = await readIfFile(path.join(root, SHELL))
		if (shell === undefined) {
			return new Response(MISSING_DASHBOARD, {
				status: 500,
				headers: { "Content-Type": TEXT_TYPE },
			})
		}
		return served(shell, SHELL_TYPE, UNCACHED)
	})
	return app
}
