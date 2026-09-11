import type { Hono } from "hono"
import { bodyLimit } from "hono/body-limit"

export const REQUEST_BODY_LIMIT_BYTES = 256 * 1024

export const applyRequestLimits = (app: Hono): void => {
	app.use(
		"*",
		bodyLimit({
			maxSize: REQUEST_BODY_LIMIT_BYTES,
			onError: (c) => c.json({ message: "That request was too large." }, 413),
		}),
	)
}
