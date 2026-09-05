import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute } from "@tanstack/react-router"
import { CircleAlert, Info, KeyRound, Plus, Trash2 } from "lucide-react"
import { type FormEvent, useState } from "react"
import { CopyButton } from "~/components/copy-button"
import { EmptyState } from "~/components/empty-state"
import { Alert } from "~/components/ui/alert"
import { Button } from "~/components/ui/button"
import { ConfirmDialog } from "~/components/ui/dialog"
import { Input } from "~/components/ui/input"
import { Label } from "~/components/ui/label"
import { Modal } from "~/components/ui/modal"
import { useViewMode, ViewToggle } from "~/components/view-toggle"
import { getErrorMessage } from "~/lib/errors"
import { keyTypeOf } from "~/lib/ssh-key-type"
import { useTRPC } from "~/lib/trpc"

export const Route = createFileRoute("/_authenticated/ssh-keys")({
	component: SshKeysPage,
})

function SshKeysPage() {
	const trpc = useTRPC()
	const queryClient = useQueryClient()
	const [pendingDelete, setPendingDelete] = useState<string | undefined>(undefined)
	const [creating, setCreating] = useState(false)
	const [view, setView] = useViewMode("open-mcc.view.ssh-keys")
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
					setCreating(false)
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
			<div className="flex items-center justify-between">
				<h1 className="text-lg font-semibold text-foreground">SSH keys</h1>
				<div className="flex items-center gap-2">
					<ViewToggle mode={view} onChange={setView} label="Key layout" />
					<Button size="sm" onClick={() => setCreating(true)}>
						<Plus className="size-4" />
						Generate key
					</Button>
				</div>
			</div>

			<Alert variant="info" controlAlignment="first-line" icon={<Info />}>
				Key pairs are generated on the server. Private keys are encrypted at rest and never leave
				it. Enrolling a host issues the command that installs the matching public key on that host.
			</Alert>

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
				<EmptyState
					icon={KeyRound}
					title="No SSH keys"
					description="The control plane authenticates to every host with a key generated here. Generate one before enrolling a host."
					action={
						<Button size="sm" onClick={() => setCreating(true)}>
							<Plus className="size-4" />
							Generate key
						</Button>
					}
				/>
			) : null}

			{sshKeysQuery.data && sshKeysQuery.data.length > 0 ? (
				view === "cards" ? (
					<div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
						{sshKeysQuery.data.map((sshKey) => (
							<div
								key={sshKey.id}
								className="flex items-center gap-3 rounded-[var(--radius)] border border-border bg-card p-3"
							>
								<span className="grid size-9 shrink-0 place-items-center rounded-[calc(var(--radius)-2px)] bg-muted">
									<KeyRound className="size-4 text-muted-foreground" aria-hidden />
								</span>
								<div className="min-w-0 flex-1">
									<p className="truncate font-medium text-foreground">{sshKey.name}</p>
									<p className="truncate text-xs text-muted-foreground">
										{keyTypeOf(sshKey.publicKey)}
									</p>
								</div>
								<div className="flex shrink-0 gap-1">
									<CopyButton value={sshKey.publicKey} label="Public key" />
									<Button
										type="button"
										variant="destructive-outline"
										size="icon"
										aria-label={`Delete ${sshKey.name}`}
										disabled={deleteMutation.isPending}
										onClick={() => setPendingDelete(sshKey.id)}
									>
										<Trash2 />
									</Button>
								</div>
							</div>
						))}
					</div>
				) : (
					<div className="divide-y divide-border overflow-hidden rounded-[var(--radius)] border border-border bg-card">
						{sshKeysQuery.data.map((sshKey) => (
							<div key={sshKey.id} className="flex items-center gap-3 px-4 py-3">
								<KeyRound className="size-4 shrink-0 text-muted-foreground" aria-hidden />
								<div className="min-w-0 flex-1">
									<p className="truncate font-medium text-foreground">{sshKey.name}</p>
									<p className="truncate font-mono text-xs text-muted-foreground">
										{sshKey.publicKey}
									</p>
								</div>
								<span className="shrink-0 text-xs text-muted-foreground">
									{keyTypeOf(sshKey.publicKey)}
								</span>
								<div className="flex shrink-0 gap-1">
									<CopyButton value={sshKey.publicKey} label="Public key" />
									<Button
										type="button"
										variant="destructive-outline"
										size="icon"
										aria-label={`Delete ${sshKey.name}`}
										disabled={deleteMutation.isPending}
										onClick={() => setPendingDelete(sshKey.id)}
									>
										<Trash2 />
									</Button>
								</div>
							</div>
						))}
					</div>
				)
			) : null}

			<Modal
				open={creating}
				title="Generate an SSH key"
				description="The key pair is generated on the server. The private key is encrypted at rest and never leaves it."
				onClose={() => setCreating(false)}
			>
				<form onSubmit={handleCreate} className="space-y-4">
					{createMutation.isError ? (
						<Alert variant="error" icon={<CircleAlert />}>
							{getErrorMessage(createMutation.error)}
						</Alert>
					) : null}
					<div className="space-y-1.5">
						<Label htmlFor="sshKeyName">Name</Label>
						<Input
							id="sshKeyName"
							required
							autoFocus
							maxLength={64}
							placeholder="fleet-production"
							value={name}
							onChange={(event) => setName(event.target.value)}
						/>
						<p className="text-xs text-muted-foreground">
							Names the key in this dashboard. It is not sent to any host.
						</p>
					</div>
					<div className="flex justify-end gap-2">
						<Button type="button" size="sm" variant="secondary" onClick={() => setCreating(false)}>
							Cancel
						</Button>
						<Button type="submit" size="sm" disabled={createMutation.isPending}>
							{createMutation.isPending ? "Generating…" : "Generate key"}
						</Button>
					</div>
				</form>
			</Modal>

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
