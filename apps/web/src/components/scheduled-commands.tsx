import { DAYS_OF_WEEK, type DayOfWeek } from "@open-mcc/contracts"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { CircleAlert, Pause, Play, Plus, Terminal, Trash2, TriangleAlert } from "lucide-react"
import { useState } from "react"
import { Alert } from "~/components/ui/alert"
import { Button } from "~/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card"
import { Input } from "~/components/ui/input"
import { Label } from "~/components/ui/label"
import { getErrorMessage, type TRPCErrorLike } from "~/lib/errors"
import { useTRPC } from "~/lib/trpc"

export type ScheduledCommandsProps = {
	instanceId: string
}

const pad = (value: number) => String(value).padStart(2, "0")

const formatTime = (time: { hour: number; minute: number }) =>
	`${pad(time.hour)}:${pad(time.minute)}`

const parseTime = (value: string) => {
	const [hour, minute] = value.split(":")
	return { hour: Number(hour ?? 0), minute: Number(minute ?? 0) }
}

const localTimezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"

export const ScheduledCommands = ({ instanceId }: ScheduledCommandsProps) => {
	const trpc = useTRPC()
	const queryClient = useQueryClient()
	const query = useQuery(trpc.instance.listScheduledCommands.queryOptions({ instanceId }))

	const [adding, setAdding] = useState(false)
	const [name, setName] = useState("")
	const [command, setCommand] = useState("")
	const [runAt, setRunAt] = useState("09:00")
	const [days, setDays] = useState<DayOfWeek[]>([...DAYS_OF_WEEK])
	const [timezone, setTimezone] = useState(localTimezone())
	const [error, setError] = useState<string | undefined>(undefined)

	const onError = (cause: TRPCErrorLike) => setError(getErrorMessage(cause))
	const onSuccess = async () => {
		setError(undefined)
		setAdding(false)
		setName("")
		setCommand("")
		await queryClient.invalidateQueries()
	}

	const save = useMutation(
		trpc.instance.setScheduledCommand.mutationOptions({ onSuccess, onError }),
	)
	const remove = useMutation(
		trpc.instance.deleteScheduledCommand.mutationOptions({ onSuccess, onError }),
	)

	const rows = query.data ?? []

	const toggleDay = (day: DayOfWeek) =>
		setDays((current) =>
			current.includes(day) ? current.filter((each) => each !== day) : [...current, day],
		)

	return (
		<Card>
			<CardHeader className="flex flex-row items-start justify-between gap-4">
				<div>
					<CardTitle className="flex items-center gap-2">
						<Terminal className="size-4" />
						Scheduled commands
					</CardTitle>
					<p className="text-sm text-muted-foreground">
						The manager sends these into the client's console on a schedule. They run only while the
						instance is running.
					</p>
				</div>
				{!adding ? (
					<Button size="sm" variant="secondary" onClick={() => setAdding(true)}>
						<Plus className="size-4" />
						Add
					</Button>
				) : null}
			</CardHeader>

			<CardContent className="space-y-4">
				{error ? (
					<Alert variant="error" icon={<CircleAlert />}>
						{error}
					</Alert>
				) : null}

				{query.isPending ? (
					<p className="text-sm text-muted-foreground">Loading schedules…</p>
				) : null}

				{!query.isPending && rows.length === 0 && !adding ? (
					<p className="text-sm text-muted-foreground">
						No scheduled commands. Add one to run something like <code>/afk</code> on a timer.
					</p>
				) : null}

				{rows.length > 0 ? (
					<ul className="divide-y divide-border overflow-hidden rounded-[var(--radius)] border border-border">
						{rows.map((row) => (
							<li key={row.id} className="space-y-1 px-3 py-2.5">
								<div className="flex items-start justify-between gap-3">
									<div className="min-w-0">
										<p className="truncate text-sm font-medium text-foreground">{row.name}</p>
										<p className="truncate font-mono text-xs text-muted-foreground">
											{row.command}
										</p>
									</div>
									<div className="flex shrink-0 items-center gap-3">
										<span className="text-xs tabular-nums text-muted-foreground">
											{formatTime(row.runAt)} {row.timezone}
										</span>
										<button
											type="button"
											aria-label={`${row.enabled ? "Pause" : "Resume"} ${row.name}`}
											disabled={save.isPending}
											onClick={() =>
												save.mutate({
													instanceId,
													name: row.name,
													command: row.command,
													daysOfWeek: [...row.daysOfWeek],
													runAt: row.runAt,
													timezone: row.timezone,
													enabled: !row.enabled,
												})
											}
											className="text-muted-foreground hover:text-foreground"
										>
											{row.enabled ? <Pause className="size-4" /> : <Play className="size-4" />}
										</button>
										<button
											type="button"
											aria-label={`Delete ${row.name}`}
											disabled={remove.isPending}
											onClick={() => remove.mutate({ id: row.id })}
											className="text-muted-foreground hover:text-error"
										>
											<Trash2 className="size-4" />
										</button>
									</div>
								</div>
								<p className="text-xs text-muted-foreground">
									{row.enabled ? "" : "Paused · "}
									{row.daysOfWeek.length === 7 ? "Every day" : row.daysOfWeek.join(", ")}
									{row.lastRunAt
										? ` · last ran ${new Date(row.lastRunAt).toLocaleString()}`
										: " · never run"}
								</p>
								{row.lastRunError ? (
									<Alert variant="warning" icon={<TriangleAlert />}>
										<span className="text-sm">Last run failed: {row.lastRunError}</span>
									</Alert>
								) : null}
							</li>
						))}
					</ul>
				) : null}

				{adding ? (
					<div className="space-y-3 rounded-[var(--radius)] border border-border p-3">
						<div className="grid gap-3 sm:grid-cols-2">
							<div className="space-y-1.5">
								<Label htmlFor="cmd-name">Name</Label>
								<Input
									id="cmd-name"
									value={name}
									placeholder="morning wave"
									onChange={(event) => setName(event.target.value)}
								/>
							</div>
							<div className="space-y-1.5">
								<Label htmlFor="cmd-text">Command</Label>
								<Input
									id="cmd-text"
									value={command}
									placeholder="/say good morning"
									onChange={(event) => setCommand(event.target.value)}
								/>
							</div>
							<div className="space-y-1.5">
								<Label htmlFor="cmd-time">Run at</Label>
								<Input
									id="cmd-time"
									type="time"
									value={runAt}
									onChange={(event) => setRunAt(event.target.value)}
								/>
							</div>
							<div className="space-y-1.5">
								<Label htmlFor="cmd-tz">Timezone</Label>
								<Input
									id="cmd-tz"
									value={timezone}
									onChange={(event) => setTimezone(event.target.value)}
								/>
							</div>
						</div>

						<div className="flex flex-wrap gap-1.5">
							{DAYS_OF_WEEK.map((day) => (
								<button
									key={day}
									type="button"
									onClick={() => toggleDay(day)}
									className={
										days.includes(day)
											? "rounded-[var(--control-radius)] border border-primary bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground"
											: "rounded-[var(--control-radius)] border border-border px-2.5 py-1 text-xs font-medium text-muted-foreground hover:bg-accent"
									}
								>
									{day}
								</button>
							))}
						</div>

						<div className="flex flex-wrap gap-2">
							<Button
								size="sm"
								disabled={
									save.isPending ||
									days.length === 0 ||
									name.trim().length === 0 ||
									command.trim().length === 0
								}
								onClick={() =>
									save.mutate({
										instanceId,
										name: name.trim(),
										command: command.trim(),
										daysOfWeek: days,
										runAt: parseTime(runAt),
										timezone,
										enabled: true,
									})
								}
							>
								{save.isPending ? "Saving…" : "Save command"}
							</Button>
							<Button size="sm" variant="secondary" onClick={() => setAdding(false)}>
								Cancel
							</Button>
						</div>
					</div>
				) : null}
			</CardContent>
		</Card>
	)
}
