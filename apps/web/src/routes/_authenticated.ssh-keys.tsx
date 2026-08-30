import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute } from "@tanstack/react-router"
import { Copy, Trash2 } from "lucide-react"
import { type FormEvent, useState } from "react"
import { Alert } from "~/components/ui/alert"
import { Button } from "~/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card"
import { Input } from "~/components/ui/input"
import { Label } from "~/components/ui/label"
import { getErrorMessage } from "~/lib/errors"
import { useTRPC } from "~/lib/trpc"

export const Route = createFileRoute("/_authenticated/ssh-keys")({
	component: SshKeysPage,
})

function SshKeysPage() {
	const trpc = useTRPC()
	const queryClient = useQueryClient()
	const sshKeysQuery = useQuery(trpc.sshKey.list.queryOptions())
	const createMutation = useMutation(trpc.sshKey.create.mutationOptions())
	const deleteMutation = useMutation(trpc.sshKey.remove.mutationOptions())

	const [name, setName] = useState("")

	const invalidateList = () => {
		queryClient.invalidateQueries({ queryKey: trpc.sshKey.list.queryKey() })
	}

	const handleCreate = (event: FormEvent) => {
		event.preventDefault()
		createMutation.mutate(
			{ name },
			{
				onSuccess: () => {
					setName("")
					invalidateList()
				},
			},
		)
	}

	const handleDelete = (sshKeyId: string) => {
		if (
			!window.confirm(
				"Delete this SSH key? A key an enrolled host still uses cannot be deleted — remove those hosts first.",
			)
		) {
			return
		}
		deleteMutation.mutate({ sshKeyId }, { onSuccess: invalidateList })
	}

	return (
		<div className="max-w-2xl space-y-6">
			<h1 className="text-lg font-semibold text-foreground">SSH keys</h1>

			<Alert variant="info">
				open-mcc-manager generates the key pair on the server. The private key is encrypted at rest
				and never leaves the server — copy the public key below and add it to the target VPS's
				authorized_keys before enrolling a host with this key.
			</Alert>

			<Card>
				<CardHeader>
					<CardTitle>New key</CardTitle>
				</CardHeader>
				<CardContent>
					<form onSubmit={handleCreate} className="flex items-end gap-3">
						{createMutation.isError ? (
							<Alert variant="error" className="w-full">
								{getErrorMessage(createMutation.error)}
							</Alert>
						) : null}
						<div className="flex-1 space-y-2">
							<Label htmlFor="sshKeyName">Name</Label>
							<Input
								id="sshKeyName"
								required
								maxLength={64}
								value={name}
								onChange={(event) => setName(event.target.value)}
							/>
						</div>
						<Button type="submit" disabled={createMutation.isPending}>
							{createMutation.isPending ? "Generating…" : "Generate key"}
						</Button>
					</form>
				</CardContent>
			</Card>

			{sshKeysQuery.isPending ? (
				<p className="text-sm text-muted-foreground">Loading SSH keys…</p>
			) : null}

			{sshKeysQuery.isError ? (
				<Alert variant="error">{getErrorMessage(sshKeysQuery.error)}</Alert>
			) : null}

			{deleteMutation.isError ? (
				<Alert variant="error">{getErrorMessage(deleteMutation.error)}</Alert>
			) : null}

			{sshKeysQuery.data && sshKeysQuery.data.length === 0 ? (
				<p className="text-sm text-muted-foreground">No SSH keys yet.</p>
			) : null}

			{sshKeysQuery.data?.map((sshKey) => (
				<Card key={sshKey.id}>
					<CardContent className="flex items-start justify-between gap-4 pt-6">
						<div className="min-w-0 space-y-1">
							<p className="font-medium text-foreground">{sshKey.name}</p>
							<p className="truncate break-all font-mono text-xs text-muted-foreground">
								{sshKey.publicKey}
							</p>
						</div>
						<div className="flex shrink-0 gap-2">
							<Button
								type="button"
								variant="outline"
								size="icon"
								aria-label="Copy public key"
								onClick={() => navigator.clipboard.writeText(sshKey.publicKey)}
							>
								<Copy className="size-4" />
							</Button>
							<Button
								type="button"
								variant="destructive"
								size="icon"
								aria-label="Delete key"
								disabled={deleteMutation.isPending}
								onClick={() => handleDelete(sshKey.id)}
							>
								<Trash2 className="size-4" />
							</Button>
						</div>
					</CardContent>
				</Card>
			))}
		</div>
	)
}
