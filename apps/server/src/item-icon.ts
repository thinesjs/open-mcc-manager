import type { Context } from "hono"

export const ITEM_SLUG_PATTERN = /^[a-z0-9_]{1,64}$/

export const ITEM_ICON_SIZE = 4

export const ITEM_ICON_CACHE_SECONDS = 604_800

export const ITEM_ICON_TIMEOUT_MS = 6_000

export const itemIconSourceUrl = (slug: string): string =>
	`https://api.minecraftitems.xyz/api/item/${encodeURIComponent(slug)}/size=${ITEM_ICON_SIZE}`

export type IconFetch = (url: string, signal: AbortSignal) => Promise<Response>

export const readItemIcon = async (
	slug: string,
	fetchImpl: IconFetch,
): Promise<{ body: ArrayBuffer; contentType: string } | undefined> => {
	if (!ITEM_SLUG_PATTERN.test(slug)) return undefined
	const controller = new AbortController()
	const timer = setTimeout(() => controller.abort(), ITEM_ICON_TIMEOUT_MS)
	try {
		const response = await fetchImpl(itemIconSourceUrl(slug), controller.signal)
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

export const itemIconHandler =
	(fetchImpl: IconFetch) =>
	async (c: Context): Promise<Response> => {
		const image = await readItemIcon(c.req.param("slug") ?? "", fetchImpl)
		if (!image) return c.body(null, 404)
		return c.body(image.body, 200, {
			"content-type": image.contentType,
			"cache-control": `private, max-age=${ITEM_ICON_CACHE_SECONDS}`,
			"content-security-policy": "default-src 'none'",
			"x-content-type-options": "nosniff",
		})
	}

export const defaultIconFetch: IconFetch = (url, signal) => fetch(url, { signal })
