import {
	ACCOUNT_TYPE_LABELS,
	ACCOUNT_TYPES,
	type AccountType,
	isOfflineAccount,
} from "@open-mcc/contracts"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { CircleAlert } from "lucide-react"
import { type FormEvent, useState } from "react"
import { Alert } from "~/components/ui/alert"
import { Button } from "~/components/ui/button"
import { Input } from "~/components/ui/input"
import { Label } from "~/components/ui/label"
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "~/components/ui/select"
import { Spinner } from "~/components/ui/spinner"
import { getErrorMessage } from "~/lib/errors"
import { useTRPC } from "~/lib/trpc"

export type CreateInstanceFormProps = {
	hostId?: string
	onCreated: (instanceId: string) => void
	onCancel: () => void
}

export const CreateInstanceForm = ({ hostId, onCreated, onCancel }: CreateInstanceFormProps) => {
	const trpc = useTRPC()
	const queryClient = useQueryClient()
	const hostsQuery = useQuery(trpc.host.list.queryOptions())
	const createMutation = useMutation(trpc.instance.create.mutationOptions())

	const readyHosts = (hostsQuery.data ?? []).filter((host) => host.status === "ready")
	const [selectedHost, setSelectedHost] = useState(hostId ?? "")
	const [name, setName] = useState("")
	const [accountType, setAccountType] = useState<AccountType>("microsoft")
	const [minecraftAccount, setMinecraftAccount] = useState("")
	const [serverAddress, setServerAddress] = useState("")

	const isOffline = isOfflineAccount(accountType)

	const submit = (event: FormEvent) => {
		event.preventDefault()
		createMutation.mutate(
			{ hostId: selectedHost, name, accountType, minecraftAccount, serverAddress },
			{
				onSuccess: (instance) => {
					queryClient.invalidateQueries({ queryKey: trpc.instance.list.queryKey() })
					onCreated(instance.id)
				},
			},
		)
	}

	if (readyHosts.length === 0) {
		return (
			<div className="space-y-4">
				<Alert variant="info" icon={<CircleAlert />}>
					An instance runs on a provisioned host. Enroll and provision one first.
				</Alert>
				<div className="flex justify-end">
					<Button type="button" size="sm" variant="secondary" onClick={onCancel}>
						Close
					</Button>
				</div>
			</div>
		)
	}

	return (
		<form onSubmit={submit} className="space-y-4">
			{createMutation.isError ? (
				<Alert variant="error" icon={<CircleAlert />}>
					{getErrorMessage(createMutation.error)}
				</Alert>
			) : null}

			{hostId ? null : (
				<div className="space-y-1.5">
					<Label htmlFor="instance-host">Host</Label>
					<Select value={selectedHost} onValueChange={(value) => setSelectedHost(value ?? "")}>
						<SelectTrigger id="instance-host">
							<SelectValue placeholder="Select a host">
								{() => readyHosts.find((host) => host.id === selectedHost)?.name}
							</SelectValue>
						</SelectTrigger>
						<SelectContent>
							{readyHosts.map((host) => (
								<SelectItem key={host.id} value={host.id}>
									{host.name}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>
			)}

			<div className="space-y-1.5">
				<Label htmlFor="instance-name">Name</Label>
				<Input
					id="instance-name"
					required
					maxLength={64}
					placeholder="survival-afk-1"
					value={name}
					onChange={(event) => setName(event.target.value)}
				/>
				<p className="text-xs text-muted-foreground">
					Identifies this instance in the dashboard and in its systemd unit.
				</p>
			</div>

			<div className="space-y-1.5">
				<Label htmlFor="instance-account-type">Account</Label>
				<Select
					value={accountType}
					onValueChange={(value) => {
						const next = ACCOUNT_TYPES.find((candidate) => candidate === value)
						if (!next) return
						setAccountType(next)
						setMinecraftAccount("")
					}}
				>
					<SelectTrigger id="instance-account-type">
						<SelectValue>{() => ACCOUNT_TYPE_LABELS[accountType]}</SelectValue>
					</SelectTrigger>
					<SelectContent>
						{ACCOUNT_TYPES.map((option) => (
							<SelectItem key={option} value={option}>
								{ACCOUNT_TYPE_LABELS[option]}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
				<p className="text-xs text-muted-foreground">
					{isOffline
						? "Offline accounts skip Mojang's session servers. The server must run with online-mode=false."
						: "You complete the sign-in after the instance is created."}
				</p>
			</div>

			<div className="space-y-1.5">
				<Label htmlFor="instance-account">{isOffline ? "Username" : "Email address"}</Label>
				<Input
					id="instance-account"
					type={isOffline ? "text" : "email"}
					required
					maxLength={isOffline ? 16 : 255}
					placeholder={isOffline ? "Steve" : "player@example.com"}
					value={minecraftAccount}
					onChange={(event) => setMinecraftAccount(event.target.value)}
				/>
				<p className="text-xs text-muted-foreground">
					{isOffline
						? "The in-game name this instance joins as: 3 to 16 letters, digits or underscores."
						: `The ${ACCOUNT_TYPE_LABELS[accountType]} account this instance signs in as.`}
				</p>
			</div>

			<div className="space-y-1.5">
				<Label htmlFor="instance-server">Server address</Label>
				<Input
					id="instance-server"
					required
					maxLength={253}
					placeholder="play.example.net"
					value={serverAddress}
					onChange={(event) => setServerAddress(event.target.value)}
				/>
			</div>

			<div className="flex justify-end gap-2">
				<Button type="button" size="sm" variant="secondary" onClick={onCancel}>
					Cancel
				</Button>
				<Button
					type="submit"
					size="sm"
					disabled={createMutation.isPending || selectedHost.length === 0}
				>
					{createMutation.isPending ? <Spinner label="Creating" /> : "Create instance"}
				</Button>
			</div>
		</form>
	)
}
