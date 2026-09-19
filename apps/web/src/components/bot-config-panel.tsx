import type { InstanceConfigInput, InstanceConfigView } from "@open-mcc/contracts"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { CircleAlert } from "lucide-react"
import { useState } from "react"
import { BotConfigEditor } from "~/components/bot-config-editor"
import { Alert } from "~/components/ui/alert"
import { Button } from "~/components/ui/button"
import { Spinner } from "~/components/ui/spinner"
import {
	type BotConfigDraft,
	draftFrom,
	sameBotConfigDraft,
	savedFrom,
	validateBotConfig,
} from "~/lib/bot-config"
import { errorCodeOf, getConfigSaveMessage } from "~/lib/errors"
import { useTRPC } from "~/lib/trpc"

export type BotConfigPanelProps = {
	instanceId: string
	config: InstanceConfigInput
	version: number
	onSaved: () => Promise<InstanceConfigView | null>
}

export const BotConfigPanel = ({ instanceId, config, version, onSaved }: BotConfigPanelProps) => {
	const trpc = useTRPC()
	const queryClient = useQueryClient()
	const saveMutation = useMutation(trpc.instance.updateBotConfig.mutationOptions())
	const [draft, setDraft] = useState<BotConfigDraft>(() => draftFrom(config))
	const [savedVersion, setSavedVersion] = useState(version)
	const issues = validateBotConfig(draft)
	const blocked = Object.keys(issues).length > 0
	const edited = !sameBotConfigDraft(draft, draftFrom(config))

	const discard = () => {
		setDraft(draftFrom(config))
		setSavedVersion(version)
	}

	const save = () => {
		if (blocked) return
		saveMutation.mutate(
			{ instanceId, ...savedFrom(draft), expectedVersion: savedVersion },
			{
				onSuccess: async (saved) => {
					setSavedVersion(saved.version)
					await queryClient.invalidateQueries()
					await onSaved()
				},
				onError: async (error) => {
					if (errorCodeOf(error) !== "INSTANCE_CONCURRENTLY_MODIFIED") return
					const refreshed = await onSaved()
					if (!refreshed) return
					setDraft(draftFrom(refreshed.config))
					setSavedVersion(refreshed.version)
				},
			},
		)
	}

	return (
		<div className="space-y-4">
			{saveMutation.isError ? (
				<Alert variant="error" icon={<CircleAlert />}>
					{getConfigSaveMessage(saveMutation.error)}
				</Alert>
			) : null}

			<div className="flex items-start justify-between gap-4">
				<div>
					<h2 className="text-sm font-semibold text-foreground">Bots</h2>
					<p className="text-xs text-muted-foreground">
						Optional client features. They take effect the next time the bot starts.
					</p>
				</div>
				<div className="flex gap-2">
					<Button type="button" size="sm" variant="secondary" disabled={!edited} onClick={discard}>
						Discard changes
					</Button>
					<Button size="sm" onClick={save} disabled={blocked || saveMutation.isPending}>
						{saveMutation.isPending ? <Spinner label="Saving" /> : "Save bots"}
					</Button>
				</div>
			</div>

			<BotConfigEditor draft={draft} issues={issues} instance={config} onChange={setDraft} />
		</div>
	)
}
