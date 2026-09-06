import type { InstanceConfigInput } from "@open-mcc/contracts"
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

export type InstanceSettingsFormProps = {
	instanceId: string
	config: InstanceConfigInput
	onSaved: () => Promise<void>
	onCancel: () => void
}

const ON_OFF = [
	{ value: "on", label: "On", description: "" },
	{ value: "off", label: "Off", description: "" },
] as const

const boundedInt = (raw: string, fallback: number): number => {
	const parsed = Number.parseInt(raw, 10)
	return Number.isFinite(parsed) ? parsed : fallback
}

export const InstanceSettingsForm = ({
	instanceId,
	config,
	onSaved,
	onCancel,
}: InstanceSettingsFormProps) => {
	const trpc = useTRPC()
	const queryClient = useQueryClient()
	const saveMutation = useMutation(trpc.instance.updateConfig.mutationOptions())
	const [draft, setDraft] = useState<InstanceConfigInput>(config)

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

			<div className="space-y-1.5">
				<Label htmlFor="settings-server">Server address</Label>
				<Input
					id="settings-server"
					required
					maxLength={253}
					value={draft.serverAddress}
					onChange={(event) => setDraft({ ...draft, serverAddress: event.target.value })}
				/>
			</div>

			<div className="space-y-1.5">
				<Label>Rejoin after a disconnect</Label>
				<div className="grid gap-3 sm:grid-cols-2">
					<div className="space-y-1.5">
						<Label htmlFor="settings-retries" className="text-xs font-normal">
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
					<div className="space-y-1.5">
						<Label htmlFor="settings-delay" className="text-xs font-normal">
							Wait between attempts (seconds)
						</Label>
						<Input
							id="settings-delay"
							inputMode="numeric"
							value={String(draft.autoRelogDelaySeconds)}
							onChange={(event) =>
								setDraft({
									...draft,
									autoRelogDelaySeconds: boundedInt(
										event.target.value,
										draft.autoRelogDelaySeconds,
									),
								})
							}
						/>
					</div>
				</div>
			</div>

			<div className="space-y-1.5">
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

			<div className="space-y-1.5">
				<Label>Anti-AFK</Label>
				<Choice
					label="Anti-AFK"
					value={draft.antiAfkEnabled ? "on" : "off"}
					options={ON_OFF}
					onChange={(value) => setDraft({ ...draft, antiAfkEnabled: value === "on" })}
				/>
				{draft.antiAfkEnabled ? (
					<div className="space-y-1.5 pt-1">
						<Label htmlFor="settings-afk" className="text-xs font-normal">
							Act every (seconds)
						</Label>
						<Input
							id="settings-afk"
							inputMode="numeric"
							value={String(draft.antiAfkIntervalSeconds)}
							onChange={(event) =>
								setDraft({
									...draft,
									antiAfkIntervalSeconds: boundedInt(
										event.target.value,
										draft.antiAfkIntervalSeconds,
									),
								})
							}
						/>
					</div>
				) : null}
			</div>

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
						<Label>What the client keeps track of</Label>
						<p className="text-xs text-muted-foreground">
							Each of these makes the client hold more state, which costs memory, CPU and bandwidth
							on the host. Leave them off unless something reads them.
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
						<p className="text-xs text-muted-foreground">
							Grants no write of any kind. This is the only one that does not.
						</p>
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
							Reading the inventory also lets the live channel move and drop items. The client
							offers no way to have one without the other.
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
							Reading entities also lets the live channel attack and interact with them, for the
							same reason.
						</p>
					</div>
				</div>
			) : null}

			<div className="flex justify-end gap-2">
				<Button type="button" size="sm" variant="secondary" onClick={onCancel}>
					Cancel
				</Button>
				<Button type="submit" size="sm" disabled={saveMutation.isPending}>
					{saveMutation.isPending ? <Spinner label="Saving" /> : "Save settings"}
				</Button>
			</div>
		</form>
	)
}
