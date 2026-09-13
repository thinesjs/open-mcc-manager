import {
	canAdoptSelfHost,
	lingerCommand,
	needsLinger,
	type SelfHostOffer,
} from "@open-mcc/contracts"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { CircleAlert, Server } from "lucide-react"
import { CommandBlock } from "~/components/command-block"
import { Alert } from "~/components/ui/alert"
import { Button } from "~/components/ui/button"
import { Spinner } from "~/components/ui/spinner"
import { Tooltip } from "~/components/ui/tooltip"
import { getErrorMessage } from "~/lib/errors"
import { useTRPC } from "~/lib/trpc"

export const shouldOfferSelfHost = (
	offer: SelfHostOffer | null | undefined,
	hosts: readonly Pick<SelfHostOffer, "hostname" | "port">[] | undefined,
): offer is SelfHostOffer => {
	if (!offer || !hosts) return false
	return !hosts.some((host) => host.hostname === offer.hostname && host.port === offer.port)
}

export type SelfHostCardProps = {
	offer: SelfHostOffer
	onAdded: (hostId: string) => void
}

export const SelfHostCard = ({ offer, onAdded }: SelfHostCardProps) => {
	const trpc = useTRPC()
	const queryClient = useQueryClient()
	const adopt = useMutation(trpc.selfHost.adopt.mutationOptions())
	const provision = useMutation(trpc.host.provision.mutationOptions())

	const adoptable = canAdoptSelfHost(offer)
	const lingerMissing = needsLinger(offer)

	const add = () => {
		adopt.mutate(undefined, {
			onSuccess: (host) => {
				queryClient.invalidateQueries({ queryKey: trpc.host.list.queryKey() })
				queryClient.invalidateQueries({ queryKey: trpc.selfHost.offer.queryKey() })
				if (!lingerMissing) provision.mutate({ hostId: host.id })
				onAdded(host.id)
			},
		})
	}

	return (
		<div className="space-y-3 rounded-[var(--radius)] border border-border bg-card p-4">
			<div className="flex items-start justify-between gap-3">
				<div className="flex min-w-0 items-center gap-2">
					<Server className="size-4 shrink-0 text-muted-foreground" />
					<div className="min-w-0">
						<p className="truncate font-medium text-foreground">{offer.name}</p>
						<p className="truncate text-sm text-muted-foreground">
							{offer.username}@{offer.hostname}:{offer.port}
						</p>
					</div>
				</div>
				{adoptable ? (
					<Button size="sm" disabled={adopt.isPending} onClick={add}>
						{adopt.isPending ? <Spinner label="Adding" /> : "Add this machine"}
					</Button>
				) : null}
			</div>

			<p className="text-sm text-muted-foreground">
				OpenMCC runs on this machine. Add it to run bots here too.
			</p>

			<dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
				<div>
					<dt className="text-muted-foreground">Privilege</dt>
					<dd className="text-foreground">
						{offer.mode === "rootless" ? "Without root" : "With root"}
					</dd>
				</div>
				<div className="min-w-0">
					<dt className="text-muted-foreground">
						<Tooltip content="Read on this machine when OpenMCC was installed, and checked again when you add it.">
							Fingerprint
						</Tooltip>
					</dt>
					<dd className="break-all font-mono text-xs text-foreground">{offer.fingerprint}</dd>
				</div>
			</dl>

			{!offer.systemd ? (
				<Alert variant="warning" icon={<CircleAlert />}>
					This machine has no systemd, so it cannot run bots.
				</Alert>
			) : offer.reach !== "proven" ? (
				<Alert variant="warning" icon={<CircleAlert />}>
					OpenMCC cannot reach this machine, so it cannot add it.
				</Alert>
			) : null}

			{adoptable && lingerMissing ? (
				<CommandBlock
					label="Run once on this machine"
					command={lingerCommand(offer)}
					caption="Keeps bots running after you log out."
				/>
			) : null}

			{adopt.isError ? (
				<Alert variant="error" icon={<CircleAlert />}>
					{getErrorMessage(adopt.error)}
				</Alert>
			) : null}
		</div>
	)
}
