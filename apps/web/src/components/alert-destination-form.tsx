import {
	CREATABLE_DESTINATION_KINDS,
	type CreatableDestinationKind,
	DESTINATION_LABELS,
	SUBSCRIPTION_KINDS,
	SUBSCRIPTION_LABELS,
	type SubscriptionKind,
} from "@open-mcc/contracts"
import { type FormEvent, useState } from "react"
import { Button } from "~/components/ui/button"
import { Choice } from "~/components/ui/choice"
import { Input } from "~/components/ui/input"
import { Label } from "~/components/ui/label"
import { Spinner } from "~/components/ui/spinner"

export type DestinationDraft = {
	name: string
	destination:
		| { kind: "webhook"; config: { url: string } }
		| { kind: "telegram"; config: { botToken: string; chatId: string } }
	subscribedTo: SubscriptionKind[]
}

const KIND_OPTIONS = CREATABLE_DESTINATION_KINDS.map((kind) => ({
	value: kind,
	label: DESTINATION_LABELS[kind],
	description:
		kind === "webhook"
			? "Send a signed request to an endpoint you control."
			: "Send a message to a Telegram chat.",
}))

export type AlertDestinationFormProps = {
	submitLabel: string
	pending: boolean
	initial?: DestinationDraft
	onSubmit: (draft: DestinationDraft) => void
	onExplainWebhook?: () => void
}

export const AlertDestinationForm = ({
	submitLabel,
	pending,
	initial,
	onSubmit,
	onExplainWebhook,
}: AlertDestinationFormProps) => {
	const [name, setName] = useState(initial?.name ?? "")
	const [kind, setKind] = useState<CreatableDestinationKind>(initial?.destination.kind ?? "webhook")
	const [url, setUrl] = useState(
		initial?.destination.kind === "webhook" ? initial.destination.config.url : "",
	)
	const [botToken, setBotToken] = useState(
		initial?.destination.kind === "telegram" ? initial.destination.config.botToken : "",
	)
	const [chatId, setChatId] = useState(
		initial?.destination.kind === "telegram" ? initial.destination.config.chatId : "",
	)
	const [chosen, setChosen] = useState<SubscriptionKind[]>(initial?.subscribedTo ?? [])

	const toggle = (alert: SubscriptionKind) => {
		setChosen((current) =>
			current.includes(alert) ? current.filter((each) => each !== alert) : [...current, alert],
		)
	}

	const handleSubmit = (event: FormEvent) => {
		event.preventDefault()
		onSubmit({
			name,
			destination:
				kind === "webhook"
					? { kind: "webhook", config: { url } }
					: { kind: "telegram", config: { botToken, chatId } },
			subscribedTo: chosen,
		})
	}

	return (
		<form onSubmit={handleSubmit} className="space-y-5">
			<div className="space-y-2">
				<Label htmlFor="destination-name">Name</Label>
				<Input
					id="destination-name"
					value={name}
					onChange={(event) => setName(event.target.value)}
					placeholder="On-call Telegram"
					required
				/>
			</div>

			{initial === undefined ? (
				<Choice label="Destination type" value={kind} options={KIND_OPTIONS} onChange={setKind} />
			) : null}

			{kind === "webhook" ? (
				<div className="space-y-2">
					<Label htmlFor="destination-url">Webhook URL</Label>
					<Input
						id="destination-url"
						value={url}
						onChange={(event) => setUrl(event.target.value)}
						placeholder="https://example.com/alerts"
						required
					/>
					<p className="text-xs text-muted-foreground">
						OpenMCC signs every request so the receiver can verify it came from here.
						{onExplainWebhook === undefined ? null : (
							<>
								{" "}
								<button
									type="button"
									onClick={onExplainWebhook}
									className="underline underline-offset-4 transition-colors hover:text-foreground"
								>
									How it works
								</button>
							</>
						)}
					</p>
				</div>
			) : (
				<div className="grid gap-4 sm:grid-cols-2">
					<div className="space-y-2">
						<Label htmlFor="destination-token">Bot token</Label>
						<Input
							id="destination-token"
							value={botToken}
							onChange={(event) => setBotToken(event.target.value)}
							required
						/>
					</div>
					<div className="space-y-2">
						<Label htmlFor="destination-chat">Chat ID</Label>
						<Input
							id="destination-chat"
							value={chatId}
							onChange={(event) => setChatId(event.target.value)}
							required
						/>
					</div>
				</div>
			)}

			<fieldset className="space-y-2">
				<legend className="text-sm font-medium text-foreground">Send an alert when</legend>
				<div className="grid gap-2 sm:grid-cols-2">
					{SUBSCRIPTION_KINDS.map((alert) => (
						<label
							key={alert}
							className="flex cursor-pointer items-start gap-2 rounded-[var(--radius)] border border-border bg-card px-3 py-2 text-sm text-foreground"
						>
							<input
								type="checkbox"
								checked={chosen.includes(alert)}
								onChange={() => toggle(alert)}
								className="mt-0.5 size-4 accent-[var(--primary)]"
							/>
							<span className="min-w-0">
								<span className="block">{SUBSCRIPTION_LABELS[alert]}</span>
								<span className="block font-mono text-[11px] text-muted-foreground">{alert}</span>
							</span>
						</label>
					))}
				</div>
			</fieldset>

			<div className="flex justify-end">
				<Button type="submit" disabled={pending || chosen.length === 0}>
					{pending ? <Spinner className="size-4" label={submitLabel} /> : null}
					{submitLabel}
				</Button>
			</div>
		</form>
	)
}
