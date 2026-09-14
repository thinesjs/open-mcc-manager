import type { InstancePublic } from "@open-mcc/contracts"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import type { ReactElement, ReactNode } from "react"
import { ContextMenu, ContextMenuItem, ContextMenuSeparator } from "~/components/ui/context-menu"
import { useTRPC } from "~/lib/trpc"

export type InstanceContextTarget = Pick<
	InstancePublic,
	"id" | "name" | "status" | "hostId" | "minecraftAccount"
>

export type InstanceContextMenuProps = {
	instance: InstanceContextTarget
	children: ReactNode
	className?: string | undefined
	render?: ReactElement | undefined
}

const copy = (value: string): void => {
	void navigator.clipboard?.writeText(value).catch(() => undefined)
}

export const InstanceContextMenu = ({
	instance,
	children,
	className,
	render,
}: InstanceContextMenuProps) => {
	const trpc = useTRPC()
	const navigate = useNavigate()
	const queryClient = useQueryClient()

	const refresh = { onSuccess: () => queryClient.invalidateQueries() }
	const startMutation = useMutation(trpc.instance.start.mutationOptions(refresh))
	const stopMutation = useMutation(trpc.instance.stop.mutationOptions(refresh))
	const restartMutation = useMutation(trpc.instance.restart.mutationOptions(refresh))

	const href = `/instances/${instance.id}`
	const running = instance.status === "running"

	return (
		<ContextMenu
			className={className}
			render={render}
			items={
				<>
					<ContextMenuItem
						onClick={() =>
							navigate({ to: "/instances/$instanceId", params: { instanceId: instance.id } })
						}
					>
						Open
					</ContextMenuItem>
					<ContextMenuItem onClick={() => window.open(href, "_blank", "noopener")}>
						Open in new tab
					</ContextMenuItem>
					<ContextMenuItem
						onClick={() => navigate({ to: "/hosts/$hostId", params: { hostId: instance.hostId } })}
					>
						Open its server
					</ContextMenuItem>

					<ContextMenuSeparator />

					<ContextMenuItem onClick={() => copy(`${window.location.origin}${href}`)}>
						Copy link
					</ContextMenuItem>
					<ContextMenuItem onClick={() => copy(instance.minecraftAccount)}>
						Copy account
					</ContextMenuItem>

					<ContextMenuSeparator />

					{running ? (
						<>
							<ContextMenuItem onClick={() => stopMutation.mutate({ instanceId: instance.id })}>
								Stop
							</ContextMenuItem>
							<ContextMenuItem onClick={() => restartMutation.mutate({ instanceId: instance.id })}>
								Restart
							</ContextMenuItem>
						</>
					) : instance.status === "needs_auth" ? (
						<ContextMenuItem
							onClick={() =>
								navigate({ to: "/instances/$instanceId", params: { instanceId: instance.id } })
							}
						>
							Finish signing in
						</ContextMenuItem>
					) : (
						<ContextMenuItem onClick={() => startMutation.mutate({ instanceId: instance.id })}>
							Start
						</ContextMenuItem>
					)}
				</>
			}
		>
			{children}
		</ContextMenu>
	)
}
