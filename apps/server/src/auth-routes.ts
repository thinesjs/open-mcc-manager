import type { Hono } from "hono"
import type { Auth } from "./auth"

const DASHBOARD_AUTH_ROUTES = [
	{ method: "POST", path: "/api/auth/sign-in/email" },
	{ method: "POST", path: "/api/auth/sign-out" },
	{ method: "GET", path: "/api/auth/get-session" },
	{ method: "GET", path: "/api/auth/organization/list" },
	{ method: "POST", path: "/api/auth/organization/set-active" },
] as const

export const mountDashboardAuth = (app: Hono, auth: Pick<Auth, "handler">): void => {
	for (const route of DASHBOARD_AUTH_ROUTES) {
		app.on(route.method, route.path, (c) => auth.handler(c.req.raw))
	}
}
