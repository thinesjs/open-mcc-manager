import { useNavigate } from "@tanstack/react-router"
import type { ReactElement, ReactNode } from "react"
import { ContextMenu, ContextMenuItem, ContextMenuSeparator } from "~/components/ui/context-menu"

export type HostContextTarget = {
	id: string
	name: string
	hostname: string
	username: string
	port: number
	status: string
	hostKeyFingerprint: string | null
}

export type HostContextMenuProps = {
	host: HostContextTarget
	children: ReactNode
	className?: string | undefined
	render?: ReactElement | undefined
}

const copy = (value: string): void => {
	void navigator.clipboard?.writeText(value).catch(() => undefined)
}

export const HostContextMenu = ({ host, children, className, render }: HostContextMenuProps) => {
	const navigate = useNavigate()
	const href = `/hosts/${host.id}`

	return (
		<ContextMenu
			className={className}
			render={render}
			items={
				<>
					<ContextMenuItem
						onClick={() => navigate({ to: "/hosts/$hostId", params: { hostId: host.id } })}
					>
						Open
					</ContextMenuItem>
					<ContextMenuItem onClick={() => window.open(href, "_blank", "noopener")}>
						Open in new tab
					</ContextMenuItem>

					<ContextMenuSeparator />

					<ContextMenuItem onClick={() => copy(`${window.location.origin}${href}`)}>
						Copy link
					</ContextMenuItem>
					<ContextMenuItem onClick={() => copy(`${host.username}@${host.hostname}:${host.port}`)}>
						Copy address
					</ContextMenuItem>
					{host.hostKeyFingerprint === null ? null : (
						<ContextMenuItem onClick={() => copy(host.hostKeyFingerprint ?? "")}>
							Copy fingerprint
						</ContextMenuItem>
					)}
				</>
			}
		>
			{children}
		</ContextMenu>
	)
}
