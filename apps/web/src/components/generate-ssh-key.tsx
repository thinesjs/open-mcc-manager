import { useMutation } from "@tanstack/react-query"
import { CircleAlert } from "lucide-react"
import { type FormEvent, useState } from "react"
import { Alert } from "~/components/ui/alert"
import { Button } from "~/components/ui/button"
import { Input } from "~/components/ui/input"
import { Label } from "~/components/ui/label"
import { Modal } from "~/components/ui/modal"
import { Spinner } from "~/components/ui/spinner"
import { getErrorMessage } from "~/lib/errors"
import { useTRPC } from "~/lib/trpc"

export type GenerateSshKeyProps = {
	open: boolean
	onClose: () => void
	onGenerated: () => void
}

export const GenerateSshKey = ({ open, onClose, onGenerated }: GenerateSshKeyProps) => {
	const trpc = useTRPC()
	const [name, setName] = useState("")
	const createMutation = useMutation(trpc.sshKey.create.mutationOptions())

	const handleCreate = (event: FormEvent) => {
		event.preventDefault()
		createMutation.mutate(
			{ name },
			{
				onSuccess: () => {
					setName("")
					onGenerated()
				},
			},
		)
	}

	return (
		<Modal
			open={open}
			title="Generate an SSH key"
			description="The key pair is generated on the server. The private key is encrypted at rest and never leaves it."
			onClose={onClose}
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
					<Button type="button" size="sm" variant="secondary" onClick={onClose}>
						Cancel
					</Button>
					<Button type="submit" size="sm" disabled={createMutation.isPending}>
						{createMutation.isPending ? <Spinner label="Generating" /> : "Generate key"}
					</Button>
				</div>
			</form>
		</Modal>
	)
}
