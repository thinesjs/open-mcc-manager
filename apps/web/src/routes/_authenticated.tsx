import { createFileRoute, Link, Outlet, redirect, useNavigate } from "@tanstack/react-router"
import { KeyRound, LogOut, Server } from "lucide-react"
import { authClient } from "~/lib/auth-client"

export const Route = createFileRoute("/_authenticated")({
	beforeLoad: async () => {
		const session = await authClient.getSession()
		if (!session.data?.session.activeOrganizationId) {
			throw redirect({ to: "/sign-in" })
		}
	},
	component: AuthenticatedLayout,
})

const NAV_LINK_CLASSES =
	"flex items-center gap-2 rounded-[var(--control-radius)] px-3 py-2 text-sm font-medium text-sidebar-muted-foreground hover:bg-accent hover:text-foreground"

const NAV_LINK_ACTIVE_CLASSES = "bg-accent text-foreground"

function AuthenticatedLayout() {
	const navigate = useNavigate()
	const session = authClient.useSession()

	const handleSignOut = async () => {
		await authClient.signOut()
		navigate({ to: "/sign-in" })
	}

	return (
		<div className="flex min-h-dvh">
			<aside className="flex w-56 shrink-0 flex-col justify-between border-r border-sidebar-border bg-sidebar p-4 text-sidebar-foreground">
				<nav className="flex flex-col gap-1">
					<Link
						to="/hosts"
						className={NAV_LINK_CLASSES}
						activeProps={{ className: NAV_LINK_ACTIVE_CLASSES }}
					>
						<Server className="size-4" />
						Hosts
					</Link>
					<Link
						to="/ssh-keys"
						className={NAV_LINK_CLASSES}
						activeProps={{ className: NAV_LINK_ACTIVE_CLASSES }}
					>
						<KeyRound className="size-4" />
						SSH keys
					</Link>
				</nav>
				<div className="space-y-2 border-t border-sidebar-border pt-4">
					{session.data ? (
						<p className="truncate text-xs text-sidebar-muted-foreground">
							{session.data.user.email}
						</p>
					) : null}
					<button
						type="button"
						onClick={handleSignOut}
						className="flex w-full items-center gap-2 rounded-[var(--control-radius)] px-3 py-2 text-sm font-medium text-sidebar-muted-foreground hover:bg-accent hover:text-foreground"
					>
						<LogOut className="size-4" />
						Sign out
					</button>
				</div>
			</aside>
			<main className="flex-1 overflow-y-auto p-6">
				<Outlet />
			</main>
		</div>
	)
}
