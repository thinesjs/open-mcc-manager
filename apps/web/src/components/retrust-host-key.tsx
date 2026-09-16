import {
	can,
	fingerprintCommand,
	HOST_KEY_FINGERPRINT_PATTERN,
	type Role,
} from "@open-mcc/contracts"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { CircleAlert } from "lucide-react"
import { type FormEvent, useState } from "react"
import { CommandBlock } from "~/components/command-block"
import { Alert } from "~/components/ui/alert"
import { Button } from "~/components/ui/button"
import { Input } from "~/components/ui/input"
import { Label } from "~/components/ui/label"
import { Modal } from "~/components/ui/modal"
import { Spinner } from "~/components/ui/spinner"
import { getErrorMessage } from "~/lib/errors"
import { useTRPC } from "~/lib/trpc"

export type RetrustHostKeyProps = {
	hostId: string
	hostName: string
	role: Role | undefined
	disabled: boolean
}

export const RetrustHostKey = ({ hostId, hostName, role, disabled }: RetrustHostKeyProps) => {
	const trpc = useTRPC()
	const queryClient = useQueryClient()
	const retrustMutation = useMutation(trpc.host.retrustHostKey.mutationOptions())
	const [open, setOpen] = useState(false)
	const [draft, setDraft] = useState("")
	const [shown, setShown] = useState<string | undefined>(undefined)

	if (role === undefined || !can(role, "host.enroll")) return null

	const candidate = draft.trim()
	const valid = HOST_KEY_FINGERPRINT_PATTERN.test(candidate)

	const close = () => {
		setOpen(false)
		setDraft("")
		setShown(undefined)
		retrustMutation.reset()
	}

	const handleContinue = (event: FormEvent) => {
		event.preventDefault()
		if (valid) setShown(candidate)
	}

	const trust = (fingerprint: string) => {
		retrustMutation.mutate(
			{ hostId, hostKeyFingerprint: fingerprint },
			{
				onSuccess: () => {
					queryClient.invalidateQueries({ queryKey: trpc.host.list.queryKey() })
					close()
				},
			},
		)
	}

	return (
		<>
			<Button
				type="button"
				size="xs"
				variant="outline"
				aria-label="Change fingerprint"
				disabled={disabled}
				onClick={() => setOpen(true)}
			>
				Change
			</Button>
			<Modal
				open={open}
				title="Change fingerprint"
				description={`Use this after ${hostName} was reinstalled or its key was replaced.`}
				onClose={close}
			>
				{shown === undefined ? (
					<form onSubmit={handleContinue} className="space-y-4">
						<div className="space-y-1.5">
							<Label htmlFor="retrust-fingerprint">New fingerprint</Label>
							<Input
								id="retrust-fingerprint"
								autoFocus
								autoComplete="off"
								spellCheck={false}
								placeholder="SHA256:…"
								className="font-mono"
								value={draft}
								onChange={(event) => setDraft(event.target.value)}
							/>
						</div>
						<CommandBlock
							label="Fingerprint command"
							command={fingerprintCommand()}
							caption="Run it on the server itself. Never copy a fingerprint from this page."
						/>
						<div className="flex justify-end gap-2">
							<Button type="button" size="sm" variant="secondary" onClick={close}>
								Cancel
							</Button>
							<Button type="submit" size="sm" disabled={!valid}>
								Continue
							</Button>
						</div>
					</form>
				) : (
					<div className="space-y-4">
						<p className="text-sm text-muted-foreground">
							OpenMCC will only connect to {hostName} if it shows exactly this fingerprint.
						</p>
						<p className="break-all rounded-[var(--radius)] border border-border bg-muted/40 p-3 font-mono text-sm text-foreground">
							{shown}
						</p>
						{retrustMutation.isError ? (
							<Alert variant="error" icon={<CircleAlert />}>
								{getErrorMessage(retrustMutation.error)}
							</Alert>
						) : null}
						<div className="flex justify-end gap-2">
							<Button
								type="button"
								size="sm"
								variant="secondary"
								disabled={retrustMutation.isPending}
								onClick={() => {
									setShown(undefined)
									retrustMutation.reset()
								}}
							>
								Back
							</Button>
							<Button
								type="button"
								size="sm"
								disabled={retrustMutation.isPending}
								onClick={() => trust(shown)}
							>
								{retrustMutation.isPending ? <Spinner label="Trusting" /> : "Trust fingerprint"}
							</Button>
						</div>
					</div>
				)}
			</Modal>
		</>
	)
}
