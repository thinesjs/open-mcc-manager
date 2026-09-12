import { useMutation } from "@tanstack/react-query"
import { CircleAlert, SendHorizontal } from "lucide-react"
import { type FormEvent, type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react"
import { Alert } from "~/components/ui/alert"
import { Button } from "~/components/ui/button"
import { Input } from "~/components/ui/input"
import { Spinner } from "~/components/ui/spinner"
import { readCommandHistory, rememberCommand, writeCommandHistory } from "~/lib/command-history"
import { getErrorMessage } from "~/lib/errors"
import { completeName, suggestPlayers } from "~/lib/player-completion"
import { useTRPC } from "~/lib/trpc"

const COMMAND_LENGTH_LIMIT = 256

export type ConsoleComposerProps = {
	instanceId: string
	running: boolean
	players: string[] | null | undefined
	onSent: () => Promise<void>
}

export const ConsoleComposer = ({ instanceId, running, players, onSent }: ConsoleComposerProps) => {
	const trpc = useTRPC()
	const [draft, setDraft] = useState("")
	const [history, setHistory] = useState<string[]>([])
	const field = useRef<HTMLInputElement>(null)
	const sendMutation = useMutation(trpc.instance.sendCommand.mutationOptions())

	useEffect(() => {
		setHistory(readCommandHistory(instanceId))
	}, [instanceId])

	const names = useMemo(
		() => (running ? suggestPlayers(players ?? [], draft) : []),
		[running, players, draft],
	)

	const prefill = (command: string) => {
		setDraft(command)
		field.current?.focus()
	}

	const complete = (name: string) => {
		const completed = completeName(draft, name, COMMAND_LENGTH_LIMIT)
		if (completed === undefined) return
		setDraft(completed)
		field.current?.focus()
	}

	const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
		const first = names[0]
		if (event.key !== "Tab" || event.shiftKey || first === undefined) return
		event.preventDefault()
		complete(first)
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
			{names.length > 0 ? (
				<div className="flex flex-wrap items-center gap-1.5">
					<span className="text-xs text-muted-foreground">Players</span>
					{names.map((name) => (
						<button
							key={name}
							type="button"
							onClick={() => complete(name)}
							title={`Finish the name as “${name}”. Tab takes the first one.`}
							className="max-w-56 truncate rounded-full border border-border bg-muted/40 px-2.5 py-1 font-mono text-[0.6875rem] text-foreground transition-colors hover:bg-muted active:scale-[0.97]"
						>
							{name}
						</button>
					))}
				</div>
			) : null}
			<div className="flex gap-2">
				<Input
					ref={field}
					aria-label="Message or command"
					maxLength={COMMAND_LENGTH_LIMIT}
					disabled={!running || sendMutation.isPending}
					placeholder={
						running ? "Say something, /command, or !respawn" : "Start the instance to chat"
					}
					value={draft}
					onChange={(event) => setDraft(event.target.value)}
					onKeyDown={onKeyDown}
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
