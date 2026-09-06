import { DAYS_OF_WEEK, type DayOfWeek } from "@open-mcc/contracts"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { CircleAlert, Clock } from "lucide-react"
import { useState } from "react"
import { Alert } from "~/components/ui/alert"
import { Button } from "~/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card"
import { Input } from "~/components/ui/input"
import { Label } from "~/components/ui/label"
import { LoadingBlock, Spinner } from "~/components/ui/spinner"
import { getErrorMessage, type TRPCErrorLike } from "~/lib/errors"
import { useTRPC } from "~/lib/trpc"

export type SleepWindowProps = {
	instanceId: string
}

const pad = (value: number) => String(value).padStart(2, "0")

const toInputValue = (time: { hour: number; minute: number }) =>
	`${pad(time.hour)}:${pad(time.minute)}`

const fromInputValue = (value: string) => {
	const [hour, minute] = value.split(":")
	return { hour: Number(hour ?? 0), minute: Number(minute ?? 0) }
}

const localTimezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"

export const SleepWindow = ({ instanceId }: SleepWindowProps) => {
	const trpc = useTRPC()
	const queryClient = useQueryClient()
	const query = useQuery(trpc.instance.getSleepWindow.queryOptions({ instanceId }))

	const [days, setDays] = useState<DayOfWeek[]>([])
	const [stopAt, setStopAt] = useState("18:50")
	const [startAt, setStartAt] = useState("19:30")
	const [timezone, setTimezone] = useState(localTimezone())
	const [error, setError] = useState<string | undefined>(undefined)
	const [editing, setEditing] = useState(false)

	const onError = (cause: TRPCErrorLike) => setError(getErrorMessage(cause))
	const onSuccess = async () => {
		setError(undefined)
		setEditing(false)
		await queryClient.invalidateQueries()
	}

	const save = useMutation(trpc.instance.setSleepWindow.mutationOptions({ onSuccess, onError }))
	const clear = useMutation(trpc.instance.clearSleepWindow.mutationOptions({ onSuccess, onError }))

	const existing = query.data ?? undefined

	const beginEditing = () => {
		setDays(existing ? [...existing.daysOfWeek] : [...DAYS_OF_WEEK])
		setStopAt(existing ? toInputValue(existing.stopAt) : "18:50")
		setStartAt(existing ? toInputValue(existing.startAt) : "19:30")
		setTimezone(existing?.timezone ?? localTimezone())
		setEditing(true)
	}

	const toggleDay = (day: DayOfWeek) =>
		setDays((current) =>
			current.includes(day) ? current.filter((each) => each !== day) : [...current, day],
		)

	return (
		<Card>
			<CardHeader className="flex flex-row items-start justify-between gap-4">
				<div>
					<CardTitle>Sleep window</CardTitle>
					<p className="text-sm text-muted-foreground">
						Stops the bot before a server restart and starts it again afterwards.
					</p>
				</div>
				{!editing ? (
					<Button size="sm" variant="secondary" onClick={beginEditing}>
						{existing ? "Edit" : "Schedule"}
					</Button>
				) : null}
			</CardHeader>

			<CardContent className="space-y-4">
				{error ? (
					<Alert variant="error" icon={<CircleAlert />}>
						{error}
					</Alert>
				) : null}

				{!editing && query.isPending ? <LoadingBlock label="Loading schedule" /> : null}

				{!editing && !query.isPending && !existing ? (
					<p className="text-sm text-muted-foreground">
						Without a sleep window, the bot runs until stopped.
					</p>
				) : null}

				{!editing && existing ? (
					<div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
						<span className="flex items-center gap-2 text-foreground">
							<Clock className="size-4 text-muted-foreground" />
							Sleeps {toInputValue(existing.stopAt)} → {toInputValue(existing.startAt)}
						</span>
						<span className="text-muted-foreground">
							{existing.daysOfWeek.length === 7 ? "Every day" : existing.daysOfWeek.join(", ")}
						</span>
						<span className="text-muted-foreground">{existing.timezone}</span>
					</div>
				) : null}

				{editing ? (
					<div className="space-y-4">
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

						<div className="grid gap-3 sm:grid-cols-3">
							<div className="space-y-1.5">
								<Label htmlFor="sleep-stop">Stop at</Label>
								<Input
									id="sleep-stop"
									type="time"
									value={stopAt}
									onChange={(event) => setStopAt(event.target.value)}
								/>
							</div>
							<div className="space-y-1.5">
								<Label htmlFor="sleep-start">Start at</Label>
								<Input
									id="sleep-start"
									type="time"
									value={startAt}
									onChange={(event) => setStartAt(event.target.value)}
								/>
							</div>
							<div className="space-y-1.5">
								<Label htmlFor="sleep-tz">Timezone</Label>
								<Input
									id="sleep-tz"
									value={timezone}
									onChange={(event) => setTimezone(event.target.value)}
								/>
							</div>
						</div>

						<div className="flex flex-wrap gap-2">
							<Button
								size="sm"
								disabled={save.isPending || days.length === 0}
								onClick={() =>
									save.mutate({
										instanceId,
										daysOfWeek: days,
										stopAt: fromInputValue(stopAt),
										startAt: fromInputValue(startAt),
										timezone,
									})
								}
							>
								{save.isPending ? <Spinner label="Saving" /> : "Save window"}
							</Button>
							<Button size="sm" variant="secondary" onClick={() => setEditing(false)}>
								Cancel
							</Button>
							{existing ? (
								<Button
									size="sm"
									variant="destructive-outline"
									disabled={clear.isPending}
									onClick={() => clear.mutate({ instanceId })}
								>
									{clear.isPending ? <Spinner label="Removing" /> : "Remove window"}
								</Button>
							) : null}
						</div>

						{days.length === 0 ? (
							<p className="text-sm text-muted-foreground">Pick at least one day.</p>
						) : null}
					</div>
				) : null}
			</CardContent>
		</Card>
	)
}
