import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import {
	Boxes,
	KeyRound,
	LayoutDashboard,
	LogOut,
	Monitor,
	Moon,
	Play,
	RotateCcw,
	Search,
	Server,
	Square,
	Sun,
} from "lucide-react"
import { AnimatePresence, motion, useReducedMotion } from "motion/react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { authClient } from "~/lib/auth-client"
import { clearCommandHistories } from "~/lib/command-history"
import { groupPaletteItems, type PaletteItem, rankPaletteItems } from "~/lib/command-palette"
import type { TRPCErrorLike } from "~/lib/errors"
import { applyTheme, resolveTheme, storePreference, type ThemePreference } from "~/lib/theme"
import { useTRPC } from "~/lib/trpc"
import { cn } from "~/lib/utils"

type PaletteAction = PaletteItem & {
	icon: typeof Search
	run: () => void
}

export type CommandPaletteProps = {
	open: boolean
	instant: boolean
	onClose: () => void
	onActionError: (instanceId: string, error: TRPCErrorLike) => void
}

export const CommandPalette = ({ open, instant, onClose, onActionError }: CommandPaletteProps) => {
	const reduced = useReducedMotion() ?? false
	const navigate = useNavigate()
	const trpc = useTRPC()
	const [query, setQuery] = useState("")
	const [active, setActive] = useState(0)
	const field = useRef<HTMLInputElement>(null)

	const queryClient = useQueryClient()
	const instancesQuery = useQuery({ ...trpc.instance.list.queryOptions(), enabled: open })
	const hostsQuery = useQuery({ ...trpc.host.list.queryOptions(), enabled: open })
	const reportOrRefresh = {
		onSuccess: () => queryClient.invalidateQueries(),
		onError: (error: TRPCErrorLike, variables: { instanceId: string }) =>
			onActionError(variables.instanceId, error),
	}
	const startMutation = useMutation(trpc.instance.start.mutationOptions(reportOrRefresh))
	const stopMutation = useMutation(trpc.instance.stop.mutationOptions(reportOrRefresh))
	const restartMutation = useMutation(trpc.instance.restart.mutationOptions(reportOrRefresh))

	const setTheme = useCallback((preference: ThemePreference) => {
		storePreference(window.localStorage, preference)
		applyTheme(
			document.documentElement,
			resolveTheme(preference, window.matchMedia("(prefers-color-scheme: dark)").matches),
		)
	}, [])

	const go = useCallback(
		(run: () => void) => () => {
			onClose()
			run()
		},
		[onClose],
	)

	const actions = useMemo<PaletteAction[]>(() => {
		const navigation: PaletteAction[] = [
			{
				id: "nav:overview",
				label: "Overview",
				group: "Go to",
				icon: LayoutDashboard,
				run: go(() => navigate({ to: "/overview" })),
			},
			{
				id: "nav:instances",
				label: "Instances",
				group: "Go to",
				icon: Boxes,
				run: go(() => navigate({ to: "/instances" })),
			},
			{
				id: "nav:hosts",
				label: "Hosts",
				group: "Go to",
				icon: Server,
				run: go(() => navigate({ to: "/hosts" })),
			},
			{
				id: "nav:ssh-keys",
				label: "SSH keys",
				group: "Go to",
				keywords: "credentials access key",
				icon: KeyRound,
				run: go(() => navigate({ to: "/ssh-keys" })),
			},
		]

		const instances: PaletteAction[] = (instancesQuery.data ?? []).map((instance) => ({
			id: `instance:${instance.id}`,
			label: instance.name,
			group: "Instances",
			keywords: `${instance.status} ${instance.minecraftAccount}`,
			icon: Boxes,
			run: go(() =>
				navigate({ to: "/instances/$instanceId", params: { instanceId: instance.id } }),
			),
		}))

		const hosts: PaletteAction[] = (hostsQuery.data ?? []).map((host) => ({
			id: `host:${host.id}`,
			label: host.name,
			group: "Hosts",
			keywords: `${host.hostname} ${host.status}`,
			icon: Server,
			run: go(() => navigate({ to: "/hosts/$hostId", params: { hostId: host.id } })),
		}))

		const account: PaletteAction[] = [
			{
				id: "action:theme-system",
				label: "Use system theme",
				group: "Appearance",
				keywords: "appearance auto",
				icon: Monitor,
				run: go(() => setTheme("system")),
			},
			{
				id: "action:theme-light",
				label: "Use light theme",
				group: "Appearance",
				keywords: "appearance bright",
				icon: Sun,
				run: go(() => setTheme("light")),
			},
			{
				id: "action:theme-dark",
				label: "Use dark theme",
				group: "Appearance",
				keywords: "appearance night",
				icon: Moon,
				run: go(() => setTheme("dark")),
			},
			{
				id: "action:sign-out",
				label: "Sign out",
				group: "Account",
				keywords: "logout leave session",
				icon: LogOut,
				run: go(() => {
					clearCommandHistories()
					void authClient.signOut().then(() => navigate({ to: "/sign-in" }))
				}),
			},
		]

		const operations: PaletteAction[] = (instancesQuery.data ?? []).flatMap((instance) => {
			if (instance.status === "running") {
				return [
					{
						id: `stop:${instance.id}`,
						label: `Stop ${instance.name}`,
						group: "Run",
						keywords: "halt",
						icon: Square,
						run: go(() => stopMutation.mutate({ instanceId: instance.id })),
					},
					{
						id: `restart:${instance.id}`,
						label: `Restart ${instance.name}`,
						group: "Run",
						keywords: "reboot apply settings",
						icon: RotateCcw,
						run: go(() => restartMutation.mutate({ instanceId: instance.id })),
					},
				]
			}
			if (instance.status === "needs_auth") return []
			return [
				{
					id: `start:${instance.id}`,
					label: `Start ${instance.name}`,
					group: "Run",
					keywords: "launch",
					icon: Play,
					run: go(() => startMutation.mutate({ instanceId: instance.id })),
				},
			]
		})

		return [...navigation, ...instances, ...hosts, ...operations, ...account]
	}, [
		go,
		navigate,
		setTheme,
		instancesQuery.data,
		hostsQuery.data,
		startMutation,
		stopMutation,
		restartMutation,
	])

	const ranked = useMemo(() => {
		if (query.trim().length === 0) {
			return actions.filter(
				(action) =>
					action.group !== "Instances" && action.group !== "Hosts" && action.group !== "Run",
			)
		}
		return rankPaletteItems(actions, query)
	}, [actions, query])
	const groups = useMemo(() => groupPaletteItems(ranked), [ranked])

	useEffect(() => {
		if (!open) return
		setQuery("")
		setActive(0)
		const focus = window.setTimeout(() => field.current?.focus(), 10)
		return () => window.clearTimeout(focus)
	}, [open])

	useEffect(() => {
		if (!open) return
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				onClose()
				return
			}
			if (event.key === "ArrowDown") {
				event.preventDefault()
				setActive((current) => (ranked.length === 0 ? 0 : (current + 1) % ranked.length))
				return
			}
			if (event.key === "ArrowUp") {
				event.preventDefault()
				setActive((current) =>
					ranked.length === 0 ? 0 : (current - 1 + ranked.length) % ranked.length,
				)
				return
			}
			if (event.key === "Enter") {
				event.preventDefault()
				ranked[active]?.run()
			}
		}
		document.addEventListener("keydown", onKey)
		return () => document.removeEventListener("keydown", onKey)
	}, [open, onClose, ranked, active])

	let index = -1

	return (
		<AnimatePresence>
			{open ? (
				<motion.div
					className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4 pt-[12vh]"
					initial={{ opacity: 0 }}
					animate={{ opacity: 1 }}
					exit={{ opacity: 0 }}
					transition={{ duration: reduced ? 0.1 : instant ? 0 : 0.14 }}
				>
					<button
						type="button"
						aria-label="Close"
						className="absolute inset-0 cursor-default bg-black/40"
						onClick={onClose}
					/>
					<motion.div
						role="dialog"
						aria-label="Command palette"
						className="relative w-full max-w-xl overflow-hidden rounded-[var(--radius)] border border-border bg-card shadow-2xl"
						initial={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.985 }}
						animate={{ opacity: 1, scale: 1 }}
						exit={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.985 }}
						transition={{ duration: reduced ? 0.1 : instant ? 0 : 0.16, ease: [0.16, 1, 0.3, 1] }}
					>
						<div className="flex items-center gap-2 border-b border-border px-3">
							<Search className="size-4 shrink-0 text-muted-foreground" />
							<input
								ref={field}
								value={query}
								onChange={(event) => {
									setQuery(event.target.value)
									setActive(0)
								}}
								placeholder="Search instances, hosts and actions"
								aria-label="Search instances, hosts and actions"
								className="w-full bg-transparent py-3 text-sm text-foreground outline-none placeholder:text-muted-foreground"
							/>
						</div>

						<div className="max-h-80 overflow-y-auto p-1.5">
							{ranked.length === 0 ? (
								<p className="px-3 py-6 text-center text-sm text-muted-foreground">
									Nothing matches “{query}”.
								</p>
							) : (
								groups.map((group) => (
									<div key={group.group} className="mb-1 last:mb-0">
										<p className="px-2.5 py-1 text-[0.6875rem] font-semibold uppercase tracking-wider text-muted-foreground">
											{group.group}
										</p>
										{group.items.map((item) => {
											index += 1
											const position = index
											const Icon = item.icon
											return (
												<button
													key={item.id}
													type="button"
													onMouseMove={() => setActive(position)}
													onClick={item.run}
													className={cn(
														"flex w-full items-center gap-2.5 rounded-[var(--control-radius)] px-2.5 py-2 text-left text-sm transition-colors",
														position === active
															? "bg-accent text-foreground"
															: "text-muted-foreground",
													)}
												>
													<Icon className="size-4 shrink-0" />
													<span className="truncate">{item.label}</span>
												</button>
											)
										})}
									</div>
								))
							)}
						</div>
					</motion.div>
				</motion.div>
			) : null}
		</AnimatePresence>
	)
}
