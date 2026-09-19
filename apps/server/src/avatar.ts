import type { Context } from "hono"

export const MINECRAFT_NAME_PATTERN = /^[A-Za-z0-9_]{3,16}$/

export const AVATAR_SIZE = 64

export const AVATAR_CACHE_SECONDS = 21_600

export const AVATAR_FETCH_TIMEOUT_MS = 5_000

export const avatarSourceUrl = (username: string): string =>
	`https://minotar.net/avatar/${encodeURIComponent(username)}/${AVATAR_SIZE}.png`

export type AvatarFetch = (url: string, signal: AbortSignal) => Promise<Response>

export const readAvatar = async (
	username: string,
	fetchImpl: AvatarFetch,
): Promise<{ body: ArrayBuffer; contentType: string } | undefined> => {
	if (!MINECRAFT_NAME_PATTERN.test(username)) return undefined
	const controller = new AbortController()
	const timer = setTimeout(() => controller.abort(), AVATAR_FETCH_TIMEOUT_MS)
	try {
		const response = await fetchImpl(avatarSourceUrl(username), controller.signal)
		if (!response.ok) return undefined
		const contentType = response.headers.get("content-type") ?? ""
		if (!contentType.startsWith("image/")) return undefined
		return { body: await response.arrayBuffer(), contentType }
	} catch {
		return undefined
	} finally {
		clearTimeout(timer)
	}
}

export const avatarHandler =
	(fetchImpl: AvatarFetch) =>
	async (c: Context): Promise<Response> => {
		const image = await readAvatar(c.req.param("username") ?? "", fetchImpl)
		if (!image) return c.body(null, 404)
		return c.body(image.body, 200, {
			"content-type": image.contentType,
			"cache-control": `private, max-age=${AVATAR_CACHE_SECONDS}`,
			"content-security-policy": "default-src 'none'",
			"x-content-type-options": "nosniff",
		})
	}

export const defaultAvatarFetch: AvatarFetch = (url, signal) => fetch(url, { signal })

export type SessionReader = {
	api: { getSession: (input: { headers: Headers }) => Promise<object | null> }
}

export const requireSession =
	(auth: SessionReader) =>
	async (c: Context, next: () => Promise<void>): Promise<Response | undefined> => {
		const session = await auth.api.getSession({ headers: c.req.raw.headers }).catch(() => null)
		if (!session) return c.body(null, 401)
		await next()
		return undefined
	}
