import { useMutation, useQuery } from "@tanstack/react-query"
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { CircleAlert, Info } from "lucide-react"
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
import { getErrorMessage } from "~/lib/errors"
import { useTRPC } from "~/lib/trpc"

export const Route = createFileRoute("/_authenticated/hosts/new")({
	component: EnrollHostPage,
})

function EnrollHostPage() {
	const trpc = useTRPC()
	const navigate = useNavigate()
	const sshKeysQuery = useQuery(trpc.sshKey.list.queryOptions())
	const enrollMutation = useMutation(trpc.host.enroll.mutationOptions())

	const [name, setName] = useState("")
	const [hostname, setHostname] = useState("")
	const [port, setPort] = useState("22")
	const [username, setUsername] = useState("root")
	const [sshKeyId, setSshKeyId] = useState("")
	const [expectedFingerprint, setExpectedFingerprint] = useState("")

	const handleSubmit = (event: FormEvent) => {
		event.preventDefault()
		enrollMutation.mutate(
			{
				name,
				hostname,
				port: Number.parseInt(port, 10),
				username,
				sshKeyId,
				expectedFingerprint,
			},
			{
				onSuccess: (host) => {
					navigate({ to: "/hosts/$hostId", params: { hostId: host.id } })
				},
			},
		)
	}

	const hasSshKeys = (sshKeysQuery.data?.length ?? 0) > 0

	return (
		<div className="max-w-lg space-y-6">
			<h1 className="text-lg font-semibold text-foreground">Enroll a host</h1>

			{sshKeysQuery.data && !hasSshKeys ? (
				<Alert variant="info" icon={<Info />}>
					You need an SSH key before you can enroll a host.{" "}
					<Link to="/ssh-keys" className="underline-offset-4 hover:underline">
						Create one
					</Link>
					.
				</Alert>
			) : null}

			<form onSubmit={handleSubmit} className="space-y-4">
				{enrollMutation.isError ? (
					<Alert variant="error" icon={<CircleAlert />}>
						{getErrorMessage(enrollMutation.error)}
					</Alert>
				) : null}

				<div className="space-y-2">
					<Label htmlFor="name">Name</Label>
					<Input
						id="name"
						required
						maxLength={64}
						value={name}
						onChange={(event) => setName(event.target.value)}
					/>
				</div>

				<div className="grid grid-cols-3 gap-4">
					<div className="col-span-2 space-y-2">
						<Label htmlFor="hostname">Hostname or IP</Label>
						<Input
							id="hostname"
							required
							maxLength={255}
							value={hostname}
							onChange={(event) => setHostname(event.target.value)}
						/>
					</div>
					<div className="space-y-2">
						<Label htmlFor="port">Port</Label>
						<Input
							id="port"
							type="number"
							required
							min={1}
							max={65535}
							value={port}
							onChange={(event) => setPort(event.target.value)}
						/>
					</div>
				</div>

				<div className="space-y-2">
					<Label htmlFor="username">SSH username</Label>
					<Input
						id="username"
						required
						maxLength={64}
						value={username}
						onChange={(event) => setUsername(event.target.value)}
					/>
				</div>

				<div className="space-y-2">
					<Label htmlFor="sshKeyId">SSH key</Label>
					<Select
						name="sshKeyId"
						required
						items={sshKeysQuery.data?.map((sshKey) => ({ label: sshKey.name, value: sshKey.id }))}
						value={sshKeyId}
						onValueChange={(value) => setSshKeyId(value ?? "")}
					>
						<SelectTrigger id="sshKeyId">
							<SelectValue placeholder="Select a key…" />
						</SelectTrigger>
						<SelectContent>
							{sshKeysQuery.data?.map((sshKey) => (
								<SelectItem key={sshKey.id} value={sshKey.id}>
									{sshKey.name}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>

				<div className="space-y-2">
					<Label htmlFor="expectedFingerprint">Host key fingerprint (SHA256)</Label>
					<Input
						id="expectedFingerprint"
						required
						placeholder="SHA256:…"
						pattern="^SHA256:[A-Za-z0-9+/]{43}$"
						value={expectedFingerprint}
						onChange={(event) => setExpectedFingerprint(event.target.value)}
					/>
					<p className="text-sm text-muted-foreground">
						Get this from your VPS provider's console or an existing known_hosts entry — not from
						this dashboard. open-mcc-manager will connect to the host, compare its key against this
						value, and refuse to enroll it on any mismatch without revealing what the host actually
						presented, so a spoofed host can never be confirmed by trial and error.
					</p>
				</div>

				<Button type="submit" disabled={enrollMutation.isPending || !hasSshKeys}>
					{enrollMutation.isPending ? "Enrolling…" : "Enroll host"}
				</Button>
			</form>
		</div>
	)
}
