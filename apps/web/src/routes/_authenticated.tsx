import { useQuery } from "@tanstack/react-query"
import { createFileRoute, Link, Outlet, redirect, useNavigate } from "@tanstack/react-router"
import {
	Activity,
	BellRing,
	Boxes,
	KeyRound,
	LayoutDashboard,
	LogOut,
	Menu,
	Search,
	Server,
} from "lucide-react"
import { useEffect, useState } from "react"
import { AffiliationNotice } from "~/components/affiliation-notice"
import { CommandPalette } from "~/components/command-palette"
import { BuildBadge, ControlPlaneStatus } from "~/components/control-plane-status"
import { ThemeToggle } from "~/components/theme-toggle"
import { authClient } from "~/lib/auth-client"
import { navItemVisible } from "~/lib/nav-access"
import { useNavDrawer } from "~/lib/nav-drawer"
import { decideFromSession } from "~/lib/session-guard"
import { sidebarClasses } from "~/lib/sidebar"
import { useTRPC } from "~/lib/trpc"

export const Route = createFileRoute("/_authenticated")({
	beforeLoad: async () => {
		const session = await authClient.getSession()
		if (decideFromSession(session) === "redirect") {
			throw redirect({ to: "/sign-in" })
		}
	},
	component: AuthenticatedLayout,
})

const NAV_LINK_CLASSES =
	"flex items-center gap-2.5 rounded-[var(--control-radius)] px-3 py-1.5 text-sm font-medium text-sidebar-muted-foreground transition-[color,background-color,transform] duration-150 ease-out hover:bg-accent hover:text-foreground active:scale-[0.98] motion-reduce:transition-none motion-reduce:active:scale-100"

const NAV_LINK_ACTIVE_CLASSES = "bg-accent text-foreground"

const SECTIONS = [
	{
		label: undefined,
		items: [{ to: "/overview", icon: LayoutDashboard, label: "Overview" }],
	},
	{
		label: "Fleet",
		items: [
			{ to: "/instances", icon: Boxes, label: "Instances" },
			{ to: "/hosts", icon: Server, label: "Hosts" },
			{ to: "/status", icon: Activity, label: "Status" },
			{ to: "/alerts", icon: BellRing, label: "Alerts" },
		],
	},
	{
		label: "Access",
		items: [{ to: "/ssh-keys", icon: KeyRound, label: "SSH keys" }],
	},
] as const

function AuthenticatedLayout() {
	const navigate = useNavigate()
	const trpc = useTRPC()
	const session = authClient.useSession()
	const me = useQuery(trpc.member.me.queryOptions())
	const [paletteOpen, setPaletteOpen] = useState(false)
	const [paletteInstant, setPaletteInstant] = useState(false)
	const nav = useNavDrawer()

	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (event.key.toLowerCase() !== "k" || !(event.metaKey || event.ctrlKey)) return
			event.preventDefault()
			setPaletteInstant(true)
			setPaletteOpen((current) => !current)
		}
		document.addEventListener("keydown", onKey)
		return () => document.removeEventListener("keydown", onKey)
	}, [])

	const handleSignOut = async () => {
		await authClient.signOut()
		navigate({ to: "/sign-in" })
	}

	return (
		<div className="flex h-dvh overflow-hidden">
			<CommandPalette
				open={paletteOpen}
				instant={paletteInstant}
				onClose={() => setPaletteOpen(false)}
			/>
			{nav.open ? (
				<button
					type="button"
					aria-label="Close menu"
					className="fixed inset-0 z-30 bg-black/50 lg:hidden"
					onClick={nav.close}
				/>
			) : null}
			<aside
				ref={nav.panelRef}
				tabIndex={-1}
				aria-label="Main"
				className={sidebarClasses(nav.open)}
			>
				<div>
					<div className="flex items-center gap-2 px-5 py-4">
						<img
							src="/logo.png"
							alt=""
							width={28}
							height={28}
							className="size-7 shrink-0 dark:invert"
						/>
						<span className="text-sm font-semibold tracking-tight text-foreground">OpenMCC</span>
					</div>
					<BuildBadge />
					<div className="px-3 pt-1 pb-2">
						<button
							type="button"
							onClick={() => {
								setPaletteInstant(false)
								setPaletteOpen(true)
							}}
							className="flex w-full items-center gap-2.5 rounded-[var(--control-radius)] border border-sidebar-border px-3 py-1.5 text-sm text-sidebar-muted-foreground transition-[color,background-color,transform] duration-150 ease-out hover:bg-accent hover:text-foreground active:scale-[0.98] motion-reduce:transition-none motion-reduce:active:scale-100"
						>
							<Search className="size-4 shrink-0" />
							<span>Search</span>
							<kbd className="ml-auto rounded border border-sidebar-border px-1.5 py-0.5 font-sans text-[0.625rem] text-sidebar-muted-foreground">
								⌘K
							</kbd>
						</button>
					</div>
					<nav className="flex flex-col gap-5 px-3 py-2">
						{SECTIONS.map((section) => (
							<div key={section.label ?? "root"} className="flex flex-col gap-1">
								{section.label ? (
									<p className="px-3 pb-1 text-[0.6875rem] font-semibold uppercase tracking-wider text-sidebar-muted-foreground">
										{section.label}
									</p>
								) : null}
								{section.items
									.filter((item) => navItemVisible(me.data?.role, item.to))
									.map((item) => (
										<Link
											key={item.to}
											to={item.to}
											onClick={nav.close}
											className={NAV_LINK_CLASSES}
											activeProps={{ className: NAV_LINK_ACTIVE_CLASSES }}
										>
											<item.icon className="size-4" />
											{item.label}
										</Link>
									))}
							</div>
						))}
					</nav>
				</div>
				<div className="shrink-0 space-y-2 border-t border-sidebar-border p-4">
					{session.data ? (
						<div className="px-1">
							<p className="truncate text-xs font-medium text-foreground">
								{session.data.user.name || session.data.user.email}
							</p>
							<p className="truncate text-xs text-sidebar-muted-foreground">
								{session.data.user.email}
							</p>
						</div>
					) : null}
					<ThemeToggle />
					<button
						type="button"
						onClick={handleSignOut}
						className="flex w-full items-center gap-2.5 rounded-[var(--control-radius)] px-3 py-1.5 text-sm font-medium text-sidebar-muted-foreground transition-[color,background-color,transform] duration-150 ease-out hover:bg-accent hover:text-foreground active:scale-[0.98] motion-reduce:transition-none motion-reduce:active:scale-100"
					>
						<LogOut className="size-4" />
						Sign out
					</button>
					<AffiliationNotice className="mt-3 border-t border-sidebar-border px-3 pt-3" />
				</div>
			</aside>
			<main
				inert={nav.open}
				className="h-full min-w-0 flex-1 overflow-y-auto px-4 py-4 sm:px-6 lg:px-8 lg:py-6"
			>
				<div className="space-y-6">
					<button
						ref={nav.openerRef}
						type="button"
						aria-label="Open menu"
						aria-expanded={nav.open}
						className="inline-flex items-center gap-2 rounded-[var(--radius)] border border-border px-3 py-2 text-sm text-foreground lg:hidden"
						onClick={nav.show}
					>
						<Menu className="size-4" />
						Menu
					</button>
					<ControlPlaneStatus />
					<Outlet />
				</div>
			</main>
		</div>
	)
}
