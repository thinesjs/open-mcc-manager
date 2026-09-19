import { OIDC_PROVIDER_ID } from "@open-mcc/contracts"
import type { Hono } from "hono"
import type { Auth } from "./auth"

const DASHBOARD_AUTH_ROUTES = [
	{ method: "POST", path: "/api/auth/sign-in/email" },
	{ method: "POST", path: "/api/auth/sign-out" },
	{ method: "GET", path: "/api/auth/get-session" },
	{ method: "GET", path: "/api/auth/organization/list" },
	{ method: "POST", path: "/api/auth/organization/set-active" },
] as const

const OIDC_AUTH_ROUTES = [
	{ method: "POST", path: "/api/auth/sign-in/social" },
	{ method: "GET", path: `/api/auth/callback/${OIDC_PROVIDER_ID}` },
] as const

export const mountDashboardAuth = (
	app: Hono,
	auth: Pick<Auth, "handler">,
	options: { oidc?: boolean } = {},
): void => {
	const routes =
		options.oidc === true ? [...DASHBOARD_AUTH_ROUTES, ...OIDC_AUTH_ROUTES] : DASHBOARD_AUTH_ROUTES
	for (const route of routes) {
		app.on(route.method, route.path, (c) => auth.handler(c.req.raw))
	}
}
