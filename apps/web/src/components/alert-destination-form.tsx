import {
	CREATABLE_DESTINATION_KINDS,
	type CreatableDestinationKind,
	type CreateDestinationInput,
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
	destination: CreateDestinationInput["destination"]
	subscribedTo: SubscriptionKind[]
}

const KIND_COPY: Record<CreatableDestinationKind, string> = {
	webhook: "Send a signed request to an endpoint you control.",
	telegram: "Send a message to a Telegram chat.",
	discord: "Post to a Discord channel.",
	slack: "Post to a Slack channel.",
	teams: "Post to a Microsoft Teams channel.",
	gotify: "Push to your own Gotify server.",
	ntfy: "Push to your own ntfy server.",
	resend: "Send an email through Resend.",
}

const KIND_OPTIONS = CREATABLE_DESTINATION_KINDS.map((kind) => ({
	value: kind,
	label: DESTINATION_LABELS[kind],
	description: KIND_COPY[kind],
}))

const POSTS_TO_A_URL = ["webhook", "discord", "slack", "teams"] as const

type UrlKind = (typeof POSTS_TO_A_URL)[number]

const postsToAUrl = (kind: CreatableDestinationKind): kind is UrlKind =>
	POSTS_TO_A_URL.some((candidate) => candidate === kind)

const URL_LABEL: Record<UrlKind, string> = {
	webhook: "Webhook URL",
	discord: "Discord webhook URL",
	slack: "Slack webhook URL",
	teams: "Teams workflow URL",
}

const URL_PLACEHOLDER: Record<UrlKind, string> = {
	webhook: "https://example.com/alerts",
	discord: "https://discord.com/api/webhooks/…",
	slack: "https://hooks.slack.com/services/…",
	teams: "https://….environment.api.powerplatform.com/…",
}

const URL_HINT: Record<UrlKind, string> = {
	webhook: "OpenMCC signs every request so the receiver can verify it came from here.",
	discord: "Copy it from the channel's Integrations settings.",
	slack: "Copy it from the Slack app's Incoming Webhooks page.",
	teams: "Copy it from the Workflows trigger, with its access set to Anyone.",
}

const DEFAULT_PRIORITY: Record<"gotify" | "ntfy", number> = { gotify: 5, ntfy: 3 }

const PRIORITY_RANGE: Record<"gotify" | "ntfy", { min: number; max: number }> = {
	gotify: { min: 0, max: 10 },
	ntfy: { min: 1, max: 5 },
}

const urlOf = (draft: DestinationDraft | undefined): string => {
	const destination = draft?.destination
	if (destination === undefined) return ""
	if (
		destination.kind === "webhook" ||
		destination.kind === "discord" ||
		destination.kind === "slack" ||
		destination.kind === "teams"
	) {
		return destination.config.url
	}
	return ""
}

const recipientsOf = (raw: string): string[] =>
	raw
		.split(",")
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0)

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
	const [url, setUrl] = useState(urlOf(initial))
	const [botToken, setBotToken] = useState(
		initial?.destination.kind === "telegram" ? initial.destination.config.botToken : "",
	)
	const [chatId, setChatId] = useState(
		initial?.destination.kind === "telegram" ? initial.destination.config.chatId : "",
	)
	const [serverUrl, setServerUrl] = useState("")
	const [appToken, setAppToken] = useState("")
	const [topic, setTopic] = useState("")
	const [accessToken, setAccessToken] = useState("")
	const [priority, setPriority] = useState("")
	const [apiKey, setApiKey] = useState("")
	const [fromAddress, setFromAddress] = useState("")
	const [toAddresses, setToAddresses] = useState("")
	const [chosen, setChosen] = useState<SubscriptionKind[]>(initial?.subscribedTo ?? [])

	const toggle = (alert: SubscriptionKind) => {
		setChosen((current) =>
			current.includes(alert) ? current.filter((each) => each !== alert) : [...current, alert],
		)
	}

	const priorityOf = (fallback: number): number => {
		const parsed = Number(priority)
		return priority.trim() === "" || Number.isNaN(parsed) ? fallback : parsed
	}

	const configured = (): CreateDestinationInput["destination"] => {
		const built: Record<CreatableDestinationKind, () => CreateDestinationInput["destination"]> = {
			webhook: () => ({ kind: "webhook", config: { url } }),
			telegram: () => ({ kind: "telegram", config: { botToken, chatId } }),
			discord: () => ({ kind: "discord", config: { url } }),
			slack: () => ({ kind: "slack", config: { url } }),
			teams: () => ({ kind: "teams", config: { url } }),
			gotify: () => ({
				kind: "gotify",
				config: { serverUrl, appToken, priority: priorityOf(DEFAULT_PRIORITY.gotify) },
			}),
			ntfy: () => ({
				kind: "ntfy",
				config: {
					serverUrl,
					topic,
					priority: priorityOf(DEFAULT_PRIORITY.ntfy),
					...(accessToken.trim() === "" ? {} : { accessToken: accessToken.trim() }),
				},
			}),
			resend: () => ({
				kind: "resend",
				config: { apiKey, fromAddress, toAddresses: recipientsOf(toAddresses) },
			}),
		}
		return built[kind]()
	}

	const handleSubmit = (event: FormEvent) => {
		event.preventDefault()
		onSubmit({ name, destination: configured(), subscribedTo: chosen })
	}

	const range = kind === "gotify" || kind === "ntfy" ? PRIORITY_RANGE[kind] : undefined

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

			{postsToAUrl(kind) ? (
				<div className="space-y-2">
					<Label htmlFor="destination-url">{URL_LABEL[kind]}</Label>
					<Input
						id="destination-url"
						value={url}
						onChange={(event) => setUrl(event.target.value)}
						placeholder={URL_PLACEHOLDER[kind]}
						required
					/>
					<p className="text-xs text-muted-foreground">
						{URL_HINT[kind]}
						{kind === "webhook" && onExplainWebhook !== undefined ? (
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
						) : null}
					</p>
				</div>
			) : null}

			{kind === "telegram" ? (
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
			) : null}

			{kind === "gotify" || kind === "ntfy" ? (
				<div className="space-y-4">
					<div className="space-y-2">
						<Label htmlFor="destination-server">Server address</Label>
						<Input
							id="destination-server"
							value={serverUrl}
							onChange={(event) => setServerUrl(event.target.value)}
							placeholder={
								kind === "gotify" ? "https://push.example.com" : "https://ntfy.example.com"
							}
							required
						/>
						<p className="text-xs text-muted-foreground">
							The address only, with nothing after it.
						</p>
					</div>
					<div className="grid gap-4 sm:grid-cols-2">
						{kind === "gotify" ? (
							<div className="space-y-2">
								<Label htmlFor="destination-app-token">Application token</Label>
								<Input
									id="destination-app-token"
									value={appToken}
									onChange={(event) => setAppToken(event.target.value)}
									required
								/>
							</div>
						) : (
							<div className="space-y-2">
								<Label htmlFor="destination-topic">Topic</Label>
								<Input
									id="destination-topic"
									value={topic}
									onChange={(event) => setTopic(event.target.value)}
									placeholder="open-mcc"
									required
								/>
							</div>
						)}
						<div className="space-y-2">
							<Label htmlFor="destination-priority">Priority</Label>
							<Input
								id="destination-priority"
								type="number"
								inputMode="numeric"
								min={range?.min}
								max={range?.max}
								value={priority}
								onChange={(event) => setPriority(event.target.value)}
								placeholder={String(DEFAULT_PRIORITY[kind])}
							/>
							<p className="text-xs text-muted-foreground">
								{range === undefined ? null : `${range.min} to ${range.max}.`} Leave it blank for{" "}
								{DEFAULT_PRIORITY[kind]}.
							</p>
						</div>
					</div>
					{kind === "ntfy" ? (
						<div className="space-y-2">
							<Label htmlFor="destination-access-token">Access token</Label>
							<Input
								id="destination-access-token"
								value={accessToken}
								onChange={(event) => setAccessToken(event.target.value)}
							/>
							<p className="text-xs text-muted-foreground">
								Only needed if your server asks for one.
							</p>
						</div>
					) : null}
				</div>
			) : null}

			{kind === "resend" ? (
				<div className="space-y-4">
					<div className="space-y-2">
						<Label htmlFor="destination-api-key">API key</Label>
						<Input
							id="destination-api-key"
							value={apiKey}
							onChange={(event) => setApiKey(event.target.value)}
							placeholder="re_…"
							required
						/>
					</div>
					<div className="grid gap-4 sm:grid-cols-2">
						<div className="space-y-2">
							<Label htmlFor="destination-from">From</Label>
							<Input
								id="destination-from"
								type="email"
								value={fromAddress}
								onChange={(event) => setFromAddress(event.target.value)}
								placeholder="alerts@example.com"
								required
							/>
						</div>
						<div className="space-y-2">
							<Label htmlFor="destination-to">Send to</Label>
							<Input
								id="destination-to"
								value={toAddresses}
								onChange={(event) => setToAddresses(event.target.value)}
								placeholder="on-call@example.com"
								required
							/>
							<p className="text-xs text-muted-foreground">
								Separate several addresses with a comma.
							</p>
						</div>
					</div>
				</div>
			) : null}

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
