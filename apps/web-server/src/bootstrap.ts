import type { AddressInfo } from "node:net"
import type { serve } from "@hono/node-server"
import { createStaticApp } from "./static-app"

export type Serve = typeof serve

const DEFAULT_PORT = 3000

const LOWEST_PORT = 1

const HIGHEST_PORT = 65535

export const portFrom = (value: string | undefined): number => {
	if (value === undefined || value.trim().length === 0) return DEFAULT_PORT
	const parsed = Number(value)
	if (!Number.isInteger(parsed) || parsed < LOWEST_PORT || parsed > HIGHEST_PORT) {
		throw new Error(`PORT must be a port number between 1 and 65535, not ${value}`)
	}
	return parsed
}

export type WebServerOptions = {
	root: string
	port: number
	serveFn: Serve
	onListen?: (info: AddressInfo) => void
}

export const startWebServer = ({
	root,
	port,
	serveFn,
	onListen,
}: WebServerOptions): ReturnType<Serve> =>
	serveFn({ fetch: createStaticApp(root).fetch, port }, onListen)
