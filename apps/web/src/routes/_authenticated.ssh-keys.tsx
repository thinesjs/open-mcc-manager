import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute } from "@tanstack/react-router"
import { CircleAlert, Info, Trash2 } from "lucide-react"
import { type FormEvent, useState } from "react"
import { CopyButton } from "~/components/copy-button"
import { Alert } from "~/components/ui/alert"
import { Button } from "~/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card"
import { ConfirmDialog } from "~/components/ui/dialog"
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
	const [pendingDelete, setPendingDelete] = useState<string | undefined>(undefined)
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

	const handleDelete = () => {
		if (!pendingDelete) return
		deleteMutation.mutate(
			{ sshKeyId: pendingDelete },
			{
				onSuccess: () => {
					setPendingDelete(undefined)
					invalidateList()
				},
			},
		)
	}

	return (
		<div className="space-y-6">
			<h1 className="text-lg font-semibold text-foreground">SSH keys</h1>

			<Alert variant="info" controlAlignment="first-line" icon={<Info />}>
				The key pair is generated on the server. The private key is encrypted at rest and never
				leaves the server. Add the public key below to the target host's authorized_keys before
				enrolling a host against this key.
			</Alert>

			<Card>
				<CardHeader>
					<CardTitle>New key</CardTitle>
				</CardHeader>
				<CardContent>
					<form onSubmit={handleCreate} className="space-y-4">
						{createMutation.isError ? (
							<Alert variant="error" icon={<CircleAlert />}>
								{getErrorMessage(createMutation.error)}
							</Alert>
						) : null}
						<div className="flex items-end gap-3">
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
						</div>
					</form>
				</CardContent>
			</Card>

			{sshKeysQuery.isPending ? (
				<p className="text-sm text-muted-foreground">Loading SSH keys…</p>
			) : null}

			{sshKeysQuery.isError ? (
				<Alert variant="error" icon={<CircleAlert />}>
					{getErrorMessage(sshKeysQuery.error)}
				</Alert>
			) : null}

			{deleteMutation.isError ? (
				<Alert variant="error" icon={<CircleAlert />}>
					{getErrorMessage(deleteMutation.error)}
				</Alert>
			) : null}

			{sshKeysQuery.data && sshKeysQuery.data.length === 0 ? (
				<p className="text-sm text-muted-foreground">No SSH keys yet.</p>
			) : null}

			{sshKeysQuery.data?.map((sshKey) => (
				<Card key={sshKey.id}>
					<CardContent className="flex items-start justify-between gap-4">
						<div className="min-w-0 space-y-1">
							<p className="font-medium text-foreground">{sshKey.name}</p>
							<p className="truncate break-all font-mono text-xs text-muted-foreground">
								{sshKey.publicKey}
							</p>
						</div>
						<div className="flex shrink-0 gap-2">
							<CopyButton value={sshKey.publicKey} label="Public key" />
							<Button
								type="button"
								variant="destructive-outline"
								size="icon"
								aria-label="Delete key"
								disabled={deleteMutation.isPending}
								onClick={() => setPendingDelete(sshKey.id)}
							>
								<Trash2 />
							</Button>
						</div>
					</CardContent>
				</Card>
			))}

			<ConfirmDialog
				open={pendingDelete !== undefined}
				title="Delete SSH key"
				description="Any host still using this key will be unreachable. Hosts that reference it must be removed first. This action cannot be undone."
				confirmLabel="Delete key"
				destructive
				busy={deleteMutation.isPending}
				error={deleteMutation.isError ? getErrorMessage(deleteMutation.error) : undefined}
				onConfirm={handleDelete}
				onCancel={() => setPendingDelete(undefined)}
			/>
		</div>
	)
}
