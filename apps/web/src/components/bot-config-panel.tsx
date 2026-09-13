import type { InstanceConfigInput } from "@open-mcc/contracts"
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
import { getErrorMessage } from "~/lib/errors"
import { useTRPC } from "~/lib/trpc"

export type BotConfigPanelProps = {
	instanceId: string
	config: InstanceConfigInput
	onSaved: () => Promise<void>
}

export const BotConfigPanel = ({ instanceId, config, onSaved }: BotConfigPanelProps) => {
	const trpc = useTRPC()
	const queryClient = useQueryClient()
	const saveMutation = useMutation(trpc.instance.updateBotConfig.mutationOptions())
	const [draft, setDraft] = useState<BotConfigDraft>(() => draftFrom(config))
	const [boundTo, setBoundTo] = useState(instanceId)
	if (boundTo !== instanceId) {
		setBoundTo(instanceId)
		setDraft(draftFrom(config))
	}
	const issues = validateBotConfig(draft)
	const blocked = Object.keys(issues).length > 0
	const edited = !sameBotConfigDraft(draft, draftFrom(config))

	const discard = () => {
		setDraft(draftFrom(config))
	}

	const save = () => {
		if (blocked) return
		saveMutation.mutate(
			{ instanceId, ...savedFrom(draft) },
			{
				onSuccess: async () => {
					await queryClient.invalidateQueries()
					await onSaved()
				},
			},
		)
	}

	return (
		<div className="space-y-4">
			{saveMutation.isError ? (
				<Alert variant="error" icon={<CircleAlert />}>
					{getErrorMessage(saveMutation.error)}
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
