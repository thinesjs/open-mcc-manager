import { useMutation } from "@tanstack/react-query"
import { CircleAlert, SendHorizontal } from "lucide-react"
import { type FormEvent, useState } from "react"
import { Alert } from "~/components/ui/alert"
import { Button } from "~/components/ui/button"
import { Input } from "~/components/ui/input"
import { Spinner } from "~/components/ui/spinner"
import { getErrorMessage } from "~/lib/errors"
import { useTRPC } from "~/lib/trpc"

export type ConsoleComposerProps = {
	instanceId: string
	running: boolean
	onSent: () => Promise<void>
}

export const ConsoleComposer = ({ instanceId, running, onSent }: ConsoleComposerProps) => {
	const trpc = useTRPC()
	const [draft, setDraft] = useState("")
	const sendMutation = useMutation(trpc.instance.sendCommand.mutationOptions())

	const submit = (event: FormEvent) => {
		event.preventDefault()
		const command = draft.trim()
		if (command.length === 0) return
		sendMutation.mutate(
			{ instanceId, command },
			{
				onSuccess: async () => {
					setDraft("")
					await onSent()
				},
			},
		)
	}

	return (
		<form onSubmit={submit} className="space-y-1.5">
			{sendMutation.isError ? (
				<Alert variant="error" icon={<CircleAlert />}>
					{getErrorMessage(sendMutation.error)}
				</Alert>
			) : null}
			<div className="flex gap-2">
				<Input
					aria-label="Message or command"
					maxLength={256}
					disabled={!running || sendMutation.isPending}
					placeholder={
						running ? "Say something, /command, or !respawn" : "Start the instance to chat"
					}
					value={draft}
					onChange={(event) => setDraft(event.target.value)}
				/>
				<Button type="submit" size="sm" disabled={!running || draft.trim().length === 0}>
					{sendMutation.isPending ? (
						<Spinner label="Sending" />
					) : (
						<SendHorizontal className="size-4" />
					)}
					Send
				</Button>
			</div>
			<p className="text-xs text-muted-foreground">
				Plain text goes to public chat. <code>/</code> sends a server command. <code>!</code> runs a
				client command such as <code>!respawn</code>, <code>!reco</code> or <code>!list</code>.
			</p>
		</form>
	)
}
