import {
	DAYS_OF_WEEK,
	type DayOfWeek,
	type InstanceTaskPublic,
	TASK_STEP_DELAY_DEFAULT_SECONDS,
	TASK_STEPS_MAX,
	TASK_TIMES_MAX,
} from "@open-mcc/contracts"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { CircleAlert, Pause, Pencil, Play, Plus, Trash2, TriangleAlert } from "lucide-react"
import { useState } from "react"
import { Alert } from "~/components/ui/alert"
import { Button } from "~/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card"
import { Input } from "~/components/ui/input"
import { Label } from "~/components/ui/label"
import { LoadingBlock, Spinner } from "~/components/ui/spinner"
import { Tooltip } from "~/components/ui/tooltip"
import { getErrorMessage, type TRPCErrorLike } from "~/lib/errors"
import { useTRPC } from "~/lib/trpc"

export type InstanceTasksProps = {
	instanceId: string
}

type DraftStep = {
	key: string
	command: string
}

type DraftTime = {
	key: string
	daysOfWeek: DayOfWeek[]
	runAt: { hour: number; minute: number }
}

type Draft = {
	id: string | null
	name: string
	steps: DraftStep[]
	stepDelaySeconds: number
	timezone: string
	onFirstLogin: boolean
	onLogin: boolean
	onRespawn: boolean
	times: DraftTime[]
	intervalSeconds: { min: string; max: string } | null
}

let keys = 0

const nextKey = (): string => {
	keys += 1
	return `draft-${keys}`
}

const pad = (value: number) => String(value).padStart(2, "0")

const clockOf = (time: { hour: number; minute: number }) => `${pad(time.hour)}:${pad(time.minute)}`

const timeFrom = (value: string) => {
	const [hour, minute] = value.split(":")
	return { hour: Number(hour ?? 0), minute: Number(minute ?? 0) }
}

const localTimezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"

const emptyDraft = (): Draft => ({
	id: null,
	name: "",
	steps: [{ key: nextKey(), command: "" }],
	stepDelaySeconds: TASK_STEP_DELAY_DEFAULT_SECONDS,
	timezone: localTimezone(),
	onFirstLogin: false,
	onLogin: false,
	onRespawn: false,
	times: [],
	intervalSeconds: null,
})

const draftOf = (task: InstanceTaskPublic): Draft => ({
	id: task.id,
	name: task.name,
	steps: task.steps.map((step) => ({ key: nextKey(), command: step.command })),
	stepDelaySeconds: task.stepDelaySeconds,
	timezone: task.timezone,
	onFirstLogin: task.onFirstLogin,
	onLogin: task.onLogin,
	onRespawn: task.onRespawn,
	times: task.times.map((time) => ({
		key: nextKey(),
		daysOfWeek: [...time.daysOfWeek],
		runAt: time.runAt,
	})),
	intervalSeconds:
		task.interval === null
			? null
			: { min: String(task.interval.minSeconds), max: String(task.interval.maxSeconds) },
})

const everyMinute = (seconds: number) => {
	if (seconds % 3600 === 0) return `${seconds / 3600}h`
	if (seconds % 60 === 0) return `${seconds / 60}m`
	return `${seconds}s`
}

const daysLabel = (days: readonly DayOfWeek[]) =>
	days.length === 7 ? "Every day" : days.join(", ")

const triggerSummary = (task: InstanceTaskPublic): string[] => {
	const said: string[] = []
	if (task.onFirstLogin) said.push("First login")
	if (task.onLogin) said.push("Every login")
	if (task.onRespawn) said.push("Respawn")
	for (const time of task.times) said.push(`${daysLabel(time.daysOfWeek)} ${clockOf(time.runAt)}`)
	if (task.interval !== null) {
		said.push(
			task.interval.minSeconds === task.interval.maxSeconds
				? `Every ${everyMinute(task.interval.minSeconds)}`
				: `Every ${everyMinute(task.interval.minSeconds)}–${everyMinute(task.interval.maxSeconds)}`,
		)
	}
	return said
}

const hasTrigger = (draft: Draft) =>
	draft.onFirstLogin ||
	draft.onLogin ||
	draft.onRespawn ||
	draft.times.length > 0 ||
	draft.intervalSeconds !== null

const savable = (draft: Draft) =>
	draft.name.trim().length > 0 &&
	draft.steps.some((step) => step.command.trim().length > 0) &&
	hasTrigger(draft)

const toggleClass = (on: boolean) =>
	on
		? "rounded-[var(--control-radius)] border border-primary bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground"
		: "rounded-[var(--control-radius)] border border-border px-2.5 py-1 text-xs font-medium text-muted-foreground hover:bg-accent"

export const InstanceTasks = ({ instanceId }: InstanceTasksProps) => {
	const trpc = useTRPC()
	const queryClient = useQueryClient()
	const query = useQuery({
		...trpc.instance.listTasks.queryOptions({ instanceId }),
		refetchOnWindowFocus: true,
	})

	const [draft, setDraft] = useState<Draft | null>(null)
	const [error, setError] = useState<string | undefined>(undefined)

	const onError = (cause: TRPCErrorLike) => setError(getErrorMessage(cause))
	const onSuccess = async () => {
		setError(undefined)
		setDraft(null)
		await queryClient.invalidateQueries()
	}

	const save = useMutation(trpc.instance.setTask.mutationOptions({ onSuccess, onError }))
	const remove = useMutation(trpc.instance.deleteTask.mutationOptions({ onSuccess, onError }))

	const tasks = query.data ?? []

	const submit = (held: Draft, enabled: boolean) =>
		save.mutate({
			id: held.id,
			instanceId,
			name: held.name.trim(),
			steps: held.steps.map((step) => step.command.trim()).filter((step) => step.length > 0),
			stepDelaySeconds: held.stepDelaySeconds,
			enabled,
			timezone: held.timezone,
			onFirstLogin: held.onFirstLogin,
			onLogin: held.onLogin,
			onRespawn: held.onRespawn,
			times: held.times.map((time) => ({ daysOfWeek: time.daysOfWeek, runAt: time.runAt })),
			interval:
				held.intervalSeconds === null
					? null
					: {
							minSeconds: Number(held.intervalSeconds.min),
							maxSeconds: Number(held.intervalSeconds.max),
						},
		})

	return (
		<Card>
			<CardHeader className="flex flex-row items-start justify-between gap-4">
				<div>
					<CardTitle>Tasks</CardTitle>
					<p className="text-sm text-muted-foreground">
						Runs a list of commands in order when something happens.
					</p>
				</div>
				{draft === null ? (
					<Button size="sm" variant="secondary" onClick={() => setDraft(emptyDraft())}>
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

				{query.isPending ? <LoadingBlock label="Loading tasks" /> : null}

				{!query.isPending && tasks.length === 0 && draft === null ? (
					<p className="text-sm text-muted-foreground">
						No tasks. Add one to run <code>/economy</code>, then <code>/local</code>, every time the
						bot joins.
					</p>
				) : null}

				{tasks.length > 0 ? (
					<ul className="divide-y divide-border overflow-hidden rounded-[var(--radius)] border border-border">
						{tasks.map((task) => (
							<li key={task.id} className="space-y-1.5 px-3 py-2.5">
								<div className="flex items-start justify-between gap-3">
									<div className="min-w-0">
										<p className="truncate text-sm font-medium text-foreground">{task.name}</p>
										<ol className="mt-0.5 space-y-0.5">
											{task.steps.map((step) => (
												<li
													key={`${task.id}-${step.position}`}
													className="truncate font-mono text-xs text-muted-foreground"
												>
													{step.position + 1}. {step.command}
												</li>
											))}
										</ol>
									</div>
									<div className="flex shrink-0 items-center gap-3">
										<button
											type="button"
											aria-label={`Edit ${task.name}`}
											onClick={() => setDraft(draftOf(task))}
											className="text-muted-foreground hover:text-foreground"
										>
											<Pencil className="size-4" />
										</button>
										<button
											type="button"
											aria-label={`${task.enabled ? "Pause" : "Resume"} ${task.name}`}
											disabled={save.isPending}
											onClick={() => submit(draftOf(task), !task.enabled)}
											className="text-muted-foreground hover:text-foreground"
										>
											{task.enabled ? <Pause className="size-4" /> : <Play className="size-4" />}
										</button>
										<button
											type="button"
											aria-label={`Delete ${task.name}`}
											disabled={remove.isPending}
											onClick={() => remove.mutate({ id: task.id })}
											className="text-muted-foreground hover:text-error"
										>
											<Trash2 className="size-4" />
										</button>
									</div>
								</div>
								<p className="text-xs text-muted-foreground">
									{task.enabled ? "" : "Paused · "}
									{triggerSummary(task).join(" · ")}
									{task.steps.length > 1 ? ` · ${task.stepDelaySeconds}s between steps` : ""}
									{task.lastRunAt
										? ` · last ran ${new Date(task.lastRunAt).toLocaleString()}`
										: " · never run"}
								</p>
								{task.lastRunError ? (
									<Alert variant="warning" icon={<TriangleAlert />}>
										<span className="text-sm">Last run failed: {task.lastRunError}</span>
									</Alert>
								) : null}
							</li>
						))}
					</ul>
				) : null}

				{draft !== null ? (
					<TaskForm
						draft={draft}
						pending={save.isPending}
						onChange={setDraft}
						onCancel={() => setDraft(null)}
						onSave={() => submit(draft, true)}
					/>
				) : null}
			</CardContent>
		</Card>
	)
}

type TaskFormProps = {
	draft: Draft
	pending: boolean
	onChange: (draft: Draft) => void
	onCancel: () => void
	onSave: () => void
}

const TaskForm = ({ draft, pending, onChange, onCancel, onSave }: TaskFormProps) => {
	const setStep = (key: string, command: string) =>
		onChange({
			...draft,
			steps: draft.steps.map((held) => (held.key === key ? { ...held, command } : held)),
		})

	const toggleDay = (key: string, day: DayOfWeek) =>
		onChange({
			...draft,
			times: draft.times.map((time) =>
				time.key === key
					? {
							...time,
							daysOfWeek: time.daysOfWeek.includes(day)
								? time.daysOfWeek.filter((each) => each !== day)
								: DAYS_OF_WEEK.filter((each) => each === day || time.daysOfWeek.includes(each)),
						}
					: time,
			),
		})

	return (
		<div className="space-y-4 rounded-[var(--radius)] border border-border p-3">
			<div className="space-y-1.5">
				<Label htmlFor="task-name">Name</Label>
				<Input
					id="task-name"
					value={draft.name}
					placeholder="Switch to eco"
					onChange={(event) => onChange({ ...draft, name: event.target.value })}
				/>
			</div>

			<fieldset className="space-y-2">
				<legend className="text-sm font-medium text-foreground">Steps</legend>
				<p className="text-xs text-muted-foreground">Sent in order, top to bottom.</p>
				{draft.steps.map((step, index) => (
					<div key={step.key} className="flex items-center gap-2">
						<span className="w-4 shrink-0 text-xs tabular-nums text-muted-foreground">
							{index + 1}
						</span>
						<Input
							aria-label={`Step ${index + 1}`}
							value={step.command}
							placeholder={index === 0 ? "/economy" : "/local"}
							onChange={(event) => setStep(step.key, event.target.value)}
						/>
						<Button
							type="button"
							size="sm"
							variant="ghost"
							aria-label={`Remove step ${index + 1}`}
							disabled={draft.steps.length === 1}
							onClick={() =>
								onChange({
									...draft,
									steps: draft.steps.filter((held) => held.key !== step.key),
								})
							}
						>
							<Trash2 className="size-4" />
						</Button>
					</div>
				))}
				<Button
					type="button"
					size="sm"
					variant="outline"
					disabled={draft.steps.length >= TASK_STEPS_MAX}
					onClick={() =>
						onChange({ ...draft, steps: [...draft.steps, { key: nextKey(), command: "" }] })
					}
				>
					Add step
				</Button>
			</fieldset>

			{draft.steps.length > 1 ? (
				<div className="space-y-1.5">
					<Label htmlFor="task-gap">Gap between steps (seconds)</Label>
					<Input
						id="task-gap"
						type="number"
						min={0}
						max={60}
						value={String(draft.stepDelaySeconds)}
						onChange={(event) =>
							onChange({ ...draft, stepDelaySeconds: Number(event.target.value) })
						}
					/>
				</div>
			) : null}

			<fieldset className="space-y-2">
				<legend className="text-sm font-medium text-foreground">Triggers</legend>
				<div className="flex flex-wrap gap-1.5">
					<Tooltip
						content="Once per client start. A reconnect does not repeat it; restarting the bot does."
						render={
							<button
								type="button"
								onClick={() => onChange({ ...draft, onFirstLogin: !draft.onFirstLogin })}
								className={toggleClass(draft.onFirstLogin)}
							/>
						}
					>
						First login
					</Tooltip>
					<Tooltip
						content="Every time the bot joins the server, reconnects included. OpenMCC reads the bot's own log, so it starts within about 30 seconds of the join."
						render={
							<button
								type="button"
								onClick={() => onChange({ ...draft, onLogin: !draft.onLogin })}
								className={toggleClass(draft.onLogin)}
							/>
						}
					>
						Every login
					</Tooltip>
					<Tooltip
						content="Every time the client respawns, which it also does on a join and on a world change."
						render={
							<button
								type="button"
								onClick={() => onChange({ ...draft, onRespawn: !draft.onRespawn })}
								className={toggleClass(draft.onRespawn)}
							/>
						}
					>
						Respawn
					</Tooltip>
					<Tooltip
						content="Counts down only while the bot is running, so a stopped bot wakes to no backlog."
						render={
							<button
								type="button"
								onClick={() =>
									onChange({
										...draft,
										intervalSeconds:
											draft.intervalSeconds === null ? { min: "3600", max: "3600" } : null,
									})
								}
								className={toggleClass(draft.intervalSeconds !== null)}
							/>
						}
					>
						Repeat
					</Tooltip>
					<button
						type="button"
						disabled={draft.times.length >= TASK_TIMES_MAX}
						onClick={() =>
							onChange({
								...draft,
								times: [
									...draft.times,
									{
										key: nextKey(),
										daysOfWeek: [...DAYS_OF_WEEK],
										runAt: { hour: 9, minute: 0 },
									},
								],
							})
						}
						className={toggleClass(false)}
					>
						Add a time
					</button>
				</div>
			</fieldset>

			{draft.intervalSeconds !== null ? (
				<div className="grid gap-3 sm:grid-cols-2">
					<div className="space-y-1.5">
						<Label htmlFor="task-min">Every, at least (seconds)</Label>
						<Input
							id="task-min"
							type="number"
							min={5}
							value={draft.intervalSeconds.min}
							onChange={(event) =>
								onChange({
									...draft,
									intervalSeconds: {
										min: event.target.value,
										max: draft.intervalSeconds?.max ?? event.target.value,
									},
								})
							}
						/>
					</div>
					<div className="space-y-1.5">
						<Label htmlFor="task-max">And at most (seconds)</Label>
						<Input
							id="task-max"
							type="number"
							min={5}
							value={draft.intervalSeconds.max}
							onChange={(event) =>
								onChange({
									...draft,
									intervalSeconds: {
										min: draft.intervalSeconds?.min ?? event.target.value,
										max: event.target.value,
									},
								})
							}
						/>
					</div>
				</div>
			) : null}

			{draft.times.map((time, index) => (
				<div key={time.key} className="space-y-2 rounded-[var(--radius)] border border-border p-3">
					<div className="flex items-end gap-2">
						<div className="space-y-1.5">
							<Label htmlFor={`task-time-${time.key}`}>Run at</Label>
							<Input
								id={`task-time-${time.key}`}
								type="time"
								value={clockOf(time.runAt)}
								onChange={(event) =>
									onChange({
										...draft,
										times: draft.times.map((held) =>
											held.key === time.key
												? { ...held, runAt: timeFrom(event.target.value) }
												: held,
										),
									})
								}
							/>
						</div>
						<Button
							type="button"
							size="sm"
							variant="ghost"
							aria-label={`Remove time ${index + 1}`}
							onClick={() =>
								onChange({
									...draft,
									times: draft.times.filter((held) => held.key !== time.key),
								})
							}
						>
							<Trash2 className="size-4" />
						</Button>
					</div>
					<div className="flex flex-wrap gap-1.5">
						{DAYS_OF_WEEK.map((day) => (
							<button
								key={day}
								type="button"
								onClick={() => toggleDay(time.key, day)}
								className={toggleClass(time.daysOfWeek.includes(day))}
							>
								{day}
							</button>
						))}
					</div>
				</div>
			))}

			{draft.times.length > 0 ? (
				<div className="space-y-1.5">
					<Label htmlFor="task-tz">Time zone</Label>
					<Input
						id="task-tz"
						value={draft.timezone}
						onChange={(event) => onChange({ ...draft, timezone: event.target.value })}
					/>
				</div>
			) : null}

			<div className="flex flex-wrap gap-2">
				<Button size="sm" disabled={pending || !savable(draft)} onClick={onSave}>
					{pending ? <Spinner label="Saving" /> : "Save task"}
				</Button>
				<Button size="sm" variant="secondary" onClick={onCancel}>
					Cancel
				</Button>
			</div>
		</div>
	)
}
