import { createRootRoute, Link, Outlet } from "@tanstack/react-router"

export const Route = createRootRoute({
	component: () => <Outlet />,
	notFoundComponent: () => (
		<div className="flex min-h-dvh flex-col items-center justify-center gap-2 p-6 text-center">
			<p className="text-lg font-semibold text-foreground">Page not found</p>
			<Link to="/hosts" className="text-sm text-primary underline-offset-4 hover:underline">
				Back to hosts
			</Link>
		</div>
	),
})
