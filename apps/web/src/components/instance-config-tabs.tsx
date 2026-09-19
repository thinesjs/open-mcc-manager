import type { InstanceConfigView } from "@open-mcc/contracts"
import { BotConfigPanel } from "~/components/bot-config-panel"
import { InstanceSettingsForm } from "~/components/instance-settings-form"
import { Spinner } from "~/components/ui/spinner"

export type InstanceConfigTabProps = {
	instanceId: string
	pending: boolean
	saved: InstanceConfigView | null | undefined
	onSaved: () => Promise<InstanceConfigView | null>
}

const NOTHING_SAVED = (
	<p className="text-sm text-muted-foreground">No saved settings for this instance.</p>
)

export const InstanceSettingsTab = ({
	instanceId,
	pending,
	saved,
	onSaved,
}: InstanceConfigTabProps) => {
	if (pending) return <Spinner label="Loading settings" />
	if (!saved) return NOTHING_SAVED

	return (
		<section className="space-y-4 rounded-[var(--radius)] border border-border bg-card p-4">
			<div>
				<h2 className="text-sm font-semibold text-foreground">Settings</h2>
				<p className="text-xs text-muted-foreground">
					What this client connects to, and how it behaves while it is there. Takes effect the next
					time the bot starts.
				</p>
			</div>
			<InstanceSettingsForm
				key={instanceId}
				instanceId={instanceId}
				config={saved.config}
				version={saved.version}
				onSaved={onSaved}
			/>
		</section>
	)
}

export const InstanceBotsTab = ({
	instanceId,
	pending,
	saved,
	onSaved,
}: InstanceConfigTabProps) => {
	if (pending) return <Spinner label="Loading bots" />
	if (!saved) return NOTHING_SAVED

	return (
		<BotConfigPanel
			key={instanceId}
			instanceId={instanceId}
			config={saved.config}
			version={saved.version}
			onSaved={onSaved}
		/>
	)
}
