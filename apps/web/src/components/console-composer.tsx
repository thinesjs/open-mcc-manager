import { useMutation } from "@tanstack/react-query"
import { CircleAlert, SendHorizontal } from "lucide-react"
import { type FormEvent, useEffect, useRef, useState } from "react"
import { Alert } from "~/components/ui/alert"
import { Button } from "~/components/ui/button"
import { Input } from "~/components/ui/input"
import { Spinner } from "~/components/ui/spinner"
import { readCommandHistory, rememberCommand, writeCommandHistory } from "~/lib/command-history"
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
	const [history, setHistory] = useState<string[]>([])
	const field = useRef<HTMLInputElement>(null)
	const sendMutation = useMutation(trpc.instance.sendCommand.mutationOptions())

	useEffect(() => {
		setHistory(readCommandHistory(instanceId))
	}, [instanceId])

	const prefill = (command: string) => {
		setDraft(command)
		field.current?.focus()
	}

	const submit = (event: FormEvent) => {
		event.preventDefault()
		const command = draft.trim()
		if (command.length === 0) return
		sendMutation.mutate(
			{ instanceId, command },
			{
				onSuccess: async () => {
					const next = rememberCommand(history, command)
					setHistory(next)
					writeCommandHistory(instanceId, next)
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
			{history.length > 0 ? (
				<div className="flex flex-wrap items-center gap-1.5">
					<span className="text-xs text-muted-foreground">Recent</span>
					{history.map((command) => (
						<button
							key={command}
							type="button"
							onClick={() => prefill(command)}
							title={`Put “${command}” in the box. It is not sent until you choose Send.`}
							className="max-w-56 truncate rounded-full border border-border bg-muted/40 px-2.5 py-1 font-mono text-[0.6875rem] text-foreground transition-colors hover:bg-muted active:scale-[0.97]"
						>
							{command}
						</button>
					))}
				</div>
			) : null}
			<div className="flex gap-2">
				<Input
					ref={field}
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
				Text sends chat. <code>/</code> runs a server command. <code>!</code> runs a bot command
				such as <code>!respawn</code>.
			</p>
		</form>
	)
}
