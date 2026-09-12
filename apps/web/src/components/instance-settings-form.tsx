import type {
	DelaySecondsRange,
	InstanceConfigInput,
	InstanceSettingsInput,
} from "@open-mcc/contracts"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { CircleAlert } from "lucide-react"
import { type FormEvent, useState } from "react"
import { Alert } from "~/components/ui/alert"
import { Button } from "~/components/ui/button"
import { Choice } from "~/components/ui/choice"
import { Input } from "~/components/ui/input"
import { Label } from "~/components/ui/label"
import { Spinner } from "~/components/ui/spinner"
import { Tooltip } from "~/components/ui/tooltip"
import { getErrorMessage } from "~/lib/errors"
import { useTRPC } from "~/lib/trpc"

const scalarsFrom = (config: InstanceConfigInput): InstanceSettingsInput => {
	const { botConfig: _bots, advancedKeys: _keys, ...scalars } = config
	return scalars
}

export type InstanceSettingsFormProps = {
	instanceId: string
	config: InstanceConfigInput
	onSaved: () => Promise<void>
}

const ON_OFF = [
	{ value: "on", label: "On" },
	{ value: "off", label: "Off" },
] as const

const boundedInt = (raw: string, fallback: number): number => {
	const parsed = Number.parseInt(raw, 10)
	return Number.isFinite(parsed) ? parsed : fallback
}

type DelayRangeFieldProps = {
	id: string
	label: string
	value: DelaySecondsRange
	onChange: (value: DelaySecondsRange) => void
}

const DelayRangeField = ({ id, label, value, onChange }: DelayRangeFieldProps) => (
	<div className="space-y-1.5">
		<Label htmlFor={`${id}-min`} className="text-xs font-normal">
			{label}
		</Label>
		<div className="grid grid-cols-2 gap-2">
			<div className="space-y-1">
				<Label htmlFor={`${id}-min`} className="text-xs font-normal text-muted-foreground">
					Shortest
				</Label>
				<Input
					id={`${id}-min`}
					inputMode="numeric"
					value={String(value.min)}
					onChange={(event) =>
						onChange({ ...value, min: boundedInt(event.target.value, value.min) })
					}
				/>
			</div>
			<div className="space-y-1">
				<Label htmlFor={`${id}-max`} className="text-xs font-normal text-muted-foreground">
					Longest
				</Label>
				<Input
					id={`${id}-max`}
					inputMode="numeric"
					value={String(value.max)}
					onChange={(event) =>
						onChange({ ...value, max: boundedInt(event.target.value, value.max) })
					}
				/>
			</div>
		</div>
	</div>
)

export const InstanceSettingsForm = ({
	instanceId,
	config,
	onSaved,
}: InstanceSettingsFormProps) => {
	const trpc = useTRPC()
	const queryClient = useQueryClient()
	const saveMutation = useMutation(trpc.instance.updateConfig.mutationOptions())
	const saved = scalarsFrom(config)
	const [draft, setDraft] = useState<InstanceSettingsInput>(saved)
	const [boundTo, setBoundTo] = useState(instanceId)
	if (boundTo !== instanceId) {
		setBoundTo(instanceId)
		setDraft(saved)
	}
	const edited = JSON.stringify(draft) !== JSON.stringify(saved)

	const discard = () => {
		setDraft(saved)
	}

	const submit = (event: FormEvent) => {
		event.preventDefault()
		saveMutation.mutate(
			{ instanceId, config: draft },
			{
				onSuccess: async () => {
					await queryClient.invalidateQueries()
					await onSaved()
				},
			},
		)
	}

	return (
		<form onSubmit={submit} className="space-y-4">
			{saveMutation.isError ? (
				<Alert variant="error" icon={<CircleAlert />}>
					{getErrorMessage(saveMutation.error)}
				</Alert>
			) : null}

			<div className="gap-4 lg:columns-2">
				<div className="mb-4 break-inside-avoid space-y-1.5">
					<Label htmlFor="settings-server">Server address</Label>
					<Input
						id="settings-server"
						required
						maxLength={253}
						value={draft.serverAddress}
						onChange={(event) => setDraft({ ...draft, serverAddress: event.target.value })}
					/>
				</div>

				<div className="mb-4 break-inside-avoid space-y-1.5">
					<Label>Rejoin after a disconnect</Label>
					<Choice
						label="Rejoin after a disconnect"
						value={draft.autoRelogEnabled ? "on" : "off"}
						options={ON_OFF}
						onChange={(value) => setDraft({ ...draft, autoRelogEnabled: value === "on" })}
					/>
					<p className="text-xs text-muted-foreground">
						Turn this off for a bot that should stay offline once it drops.
					</p>
					{draft.autoRelogEnabled ? (
						<div className="grid items-end gap-3 pt-1 sm:grid-cols-2">
							<div className="space-y-1">
								<Label
									htmlFor="settings-retries"
									className="text-xs font-normal text-muted-foreground"
								>
									Attempts
								</Label>
								<Input
									id="settings-retries"
									inputMode="numeric"
									value={String(draft.autoRelogRetries)}
									onChange={(event) =>
										setDraft({
											...draft,
											autoRelogRetries: boundedInt(event.target.value, draft.autoRelogRetries),
										})
									}
								/>
							</div>
							<DelayRangeField
								id="settings-delay"
								label="Wait between attempts (seconds)"
								value={draft.autoRelogDelaySeconds}
								onChange={(autoRelogDelaySeconds) => setDraft({ ...draft, autoRelogDelaySeconds })}
							/>
						</div>
					) : null}
				</div>

				<div className="mb-4 break-inside-avoid space-y-1.5">
					<Label>Respawn after dying</Label>
					<Choice
						label="Respawn after dying"
						value={draft.autoRespawnEnabled ? "on" : "off"}
						options={ON_OFF}
						onChange={(value) => setDraft({ ...draft, autoRespawnEnabled: value === "on" })}
					/>
					<p className="text-xs text-muted-foreground">
						Leave this off unless the spawn point is safe. A lethal spawn turns respawning into a
						loop.
					</p>
				</div>

				<div className="mb-4 break-inside-avoid space-y-1.5">
					<Label>Anti-AFK</Label>
					<Choice
						label="Anti-AFK"
						value={draft.antiAfkEnabled ? "on" : "off"}
						options={ON_OFF}
						onChange={(value) => setDraft({ ...draft, antiAfkEnabled: value === "on" })}
					/>
					{draft.antiAfkEnabled ? (
						<div className="pt-1">
							<DelayRangeField
								id="settings-afk"
								label="Act every (seconds)"
								value={draft.antiAfkIntervalSeconds}
								onChange={(antiAfkIntervalSeconds) =>
									setDraft({ ...draft, antiAfkIntervalSeconds })
								}
							/>
						</div>
					) : null}
				</div>

				<div className="mb-4 break-inside-avoid space-y-4">
					<div className="space-y-1.5">
						<Label>Live control</Label>
						<Choice
							label="Live control"
							value={draft.liveControlEnabled ? "on" : "off"}
							options={ON_OFF}
							onChange={(value) => setDraft({ ...draft, liveControlEnabled: value === "on" })}
						/>
						<p className="text-xs text-muted-foreground">
							Lets you watch chat and see what the bot is doing.{" "}
							<Tooltip content="Only this dashboard can reach it, and it can only read. Anything you send still goes through the console.">
								Read-only
							</Tooltip>
							, on port {draft.liveControlPort}.
						</p>
					</div>

					{draft.liveControlEnabled ? (
						<div className="space-y-3 rounded-[var(--radius)] border border-border p-3">
							<div>
								<Label>Live details to show</Label>
								<p className="text-xs text-muted-foreground">
									Turn on only the live details you want to see.
								</p>
							</div>

							<div className="space-y-1.5">
								<Label>World and position</Label>
								<Choice
									label="World and position"
									value={draft.worldDataEnabled ? "on" : "off"}
									options={ON_OFF}
									onChange={(value) => setDraft({ ...draft, worldDataEnabled: value === "on" })}
								/>
								<p className="text-xs text-muted-foreground">View only.</p>
							</div>

							<div className="space-y-1.5">
								<Label>Inventory</Label>
								<Choice
									label="Inventory"
									value={draft.inventoryDataEnabled ? "on" : "off"}
									options={ON_OFF}
									onChange={(value) => setDraft({ ...draft, inventoryDataEnabled: value === "on" })}
								/>
								<p className="text-xs text-muted-foreground">
									Turning this on also lets OpenMCC move and drop items.
								</p>
							</div>

							<div className="space-y-1.5">
								<Label>Nearby entities</Label>
								<Choice
									label="Nearby entities"
									value={draft.entityDataEnabled ? "on" : "off"}
									options={ON_OFF}
									onChange={(value) => setDraft({ ...draft, entityDataEnabled: value === "on" })}
								/>
								<p className="text-xs text-muted-foreground">
									Turning this on also lets OpenMCC attack and interact with nearby creatures.
								</p>
							</div>
						</div>
					) : null}
				</div>
			</div>

			<div className="flex justify-end gap-2">
				<Button type="button" size="sm" variant="secondary" disabled={!edited} onClick={discard}>
					Discard changes
				</Button>
				<Button type="submit" size="sm" disabled={saveMutation.isPending}>
					{saveMutation.isPending ? <Spinner label="Saving" /> : "Save settings"}
				</Button>
			</div>
		</form>
	)
}
