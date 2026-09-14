import {
	type CreatableDestinationKind,
	canBeCreated,
	SUBSCRIPTION_LABELS,
	type SubscriptionKind,
} from "@open-mcc/contracts"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute } from "@tanstack/react-router"
import {
	BellRing,
	CircleAlert,
	CircleCheck,
	KeyRound,
	Pencil,
	Plus,
	Send,
	Trash2,
} from "lucide-react"
import { useCallback, useEffect, useState } from "react"
import { AlertDestinationForm, type DestinationDraft } from "~/components/alert-destination-form"
import { CopyButton } from "~/components/copy-button"
import { EmptyState } from "~/components/empty-state"
import { Alert } from "~/components/ui/alert"
import { Badge } from "~/components/ui/badge"
import { Button } from "~/components/ui/button"
import { ConfirmDialog } from "~/components/ui/dialog"
import { Modal } from "~/components/ui/modal"
import { LoadingBlock } from "~/components/ui/spinner"
import { WebhookContract } from "~/components/webhook-contract"
import {
	type AlertControl,
	describeTestOutcome,
	mayUseAlertControl,
	shouldKeepPolling,
	TEST_POLL_BUDGET_MS,
	TEST_POLL_INTERVAL_MS,
	type TestOutcome,
	testOutcomeOf,
} from "~/lib/alerts"
import { getErrorMessage } from "~/lib/errors"
import { useTRPC } from "~/lib/trpc"

export const Route = createFileRoute("/_authenticated/alerts")({
	component: AlertsPage,
})

const whenLast = (at: Date | string | null): string =>
	at === null ? "never" : new Date(at).toLocaleString()

const BLANK_CONFIG: Record<CreatableDestinationKind, DestinationDraft["destination"]> = {
	webhook: { kind: "webhook", config: { url: "" } },
	telegram: { kind: "telegram", config: { botToken: "", chatId: "" } },
	discord: { kind: "discord", config: { url: "" } },
	slack: { kind: "slack", config: { url: "" } },
	teams: { kind: "teams", config: { url: "" } },
	gotify: { kind: "gotify", config: { serverUrl: "", appToken: "", priority: 5 } },
	ntfy: { kind: "ntfy", config: { serverUrl: "", topic: "", priority: 3 } },
	resend: { kind: "resend", config: { apiKey: "", fromAddress: "", toAddresses: [] } },
	email: {
		kind: "email",
		config: {
			smtpServer: "",
			smtpPort: 587,
			username: "",
			password: "",
			fromAddress: "",
			toAddresses: [],
		},
	},
}

const draftFor = (
	kind: CreatableDestinationKind,
	name: string,
	subscribedTo: readonly SubscriptionKind[],
): DestinationDraft => ({
	name,
	destination: BLANK_CONFIG[kind],
	subscribedTo: [...subscribedTo],
})

const TEST_VARIANTS: Record<TestOutcome["kind"], "info" | "success" | "error"> = {
	sending: "info",
	arrived: "success",
	"did-not-arrive": "error",
	"still-sending": "info",
}

const testIcon = (outcome: TestOutcome) => {
	if (outcome.kind === "arrived") return <CircleCheck />
	if (outcome.kind === "did-not-arrive") return <CircleAlert />
	return <Send />
}

function AlertsPage() {
	const trpc = useTRPC()
	const queryClient = useQueryClient()
	const [adding, setAdding] = useState(false)
	const [explaining, setExplaining] = useState(false)
	const [pendingEdit, setPendingEdit] = useState<string | undefined>(undefined)
	const [pendingDelete, setPendingDelete] = useState<string | undefined>(undefined)
	const [pendingRotate, setPendingRotate] = useState<string | undefined>(undefined)
	const [pendingDisable, setPendingDisable] = useState<string | undefined>(undefined)
	const [revealed, setRevealed] = useState<string | undefined>(undefined)
	const [testing, setTesting] = useState<string | undefined>(undefined)
	const [waitedLongEnough, setWaitedLongEnough] = useState(false)

	const me = useQuery(trpc.member.me.queryOptions())
	const may = (control: AlertControl): boolean => mayUseAlertControl(me.data?.role, control)

	const destinations = useQuery(trpc.notification.list.queryOptions())
	const create = useMutation(trpc.notification.create.mutationOptions())
	const edit = useMutation(trpc.notification.edit.mutationOptions())
	const remove = useMutation(trpc.notification.remove.mutationOptions())
	const setEnabled = useMutation(trpc.notification.setEnabled.mutationOptions())
	const rotate = useMutation(trpc.notification.rotateSecret.mutationOptions())
	const test = useMutation(trpc.notification.test.mutationOptions())
	const failures = useQuery(trpc.notification.failures.queryOptions())
	const retry = useMutation(trpc.notification.retry.mutationOptions())
	const dismiss = useMutation(trpc.notification.dismiss.mutationOptions())

	const testResult = useQuery({
		...trpc.notification.testResult.queryOptions({ deliveryId: testing ?? "" }),
		enabled: testing !== undefined,
		refetchInterval: (query) =>
			shouldKeepPolling({
				state: query.state.data?.state,
				reason: query.state.data?.reason ?? null,
				gaveUp: waitedLongEnough,
			})
				? TEST_POLL_INTERVAL_MS
				: false,
	})

	const outcome =
		testing === undefined
			? undefined
			: testOutcomeOf({
					state: testResult.data?.state,
					reason: testResult.data?.reason ?? null,
					gaveUp: waitedLongEnough,
				})

	const refresh = useCallback(() => {
		queryClient.invalidateQueries({ queryKey: trpc.notification.list.queryKey() })
		queryClient.invalidateQueries({ queryKey: trpc.notification.failures.queryKey() })
	}, [queryClient, trpc])

	useEffect(() => {
		if (testing === undefined) return
		setWaitedLongEnough(false)
		const timer = window.setTimeout(() => setWaitedLongEnough(true), TEST_POLL_BUDGET_MS)
		return () => window.clearTimeout(timer)
	}, [testing])

	const testFinished = outcome?.kind === "arrived" || outcome?.kind === "did-not-arrive"

	useEffect(() => {
		if (testFinished) refresh()
	}, [testFinished, refresh])

	const actionError = [
		create.isError ? getErrorMessage(create.error) : undefined,
		edit.isError ? getErrorMessage(edit.error) : undefined,
		remove.isError ? getErrorMessage(remove.error) : undefined,
		setEnabled.isError ? getErrorMessage(setEnabled.error) : undefined,
		rotate.isError ? getErrorMessage(rotate.error) : undefined,
		test.isError ? getErrorMessage(test.error) : undefined,
		retry.isError ? getErrorMessage(retry.error) : undefined,
		dismiss.isError ? getErrorMessage(dismiss.error) : undefined,
	].find((message) => message !== undefined)

	const sharedTargets = new Set(
		(destinations.data ?? [])
			.map((entry) => entry.target)
			.filter((target, index, all) => all.indexOf(target) !== index),
	)

	const editing = destinations.data?.find((entry) => entry.id === pendingEdit)

	const handleCreate = (draft: DestinationDraft) => {
		create.mutate(draft, {
			onSuccess: (result) => {
				setAdding(false)
				if (result.signingSecret !== undefined) setRevealed(result.signingSecret)
				refresh()
			},
		})
	}

	return (
		<div className="space-y-6">
			<div className="flex items-start justify-between gap-4">
				<div>
					<h1 className="text-lg font-semibold text-foreground">Alerts</h1>
					<p className="text-sm text-muted-foreground">
						Where OpenMCC sends alerts when something needs your attention.
					</p>
				</div>
				{may("add") ? (
					<Button size="sm" onClick={() => setAdding(true)}>
						<Plus className="size-4" />
						Add destination
					</Button>
				) : null}
			</div>

			{destinations.isPending ? <LoadingBlock label="Loading alerts" /> : null}

			{destinations.isError ? (
				<Alert variant="error" icon={<CircleAlert />}>
					{getErrorMessage(destinations.error)}
				</Alert>
			) : null}

			{actionError === undefined ? null : (
				<Alert variant="error" icon={<CircleAlert />}>
					{actionError}
				</Alert>
			)}

			{outcome === undefined ? null : (
				<Alert variant={TEST_VARIANTS[outcome.kind]} icon={testIcon(outcome)}>
					{describeTestOutcome(outcome)}
				</Alert>
			)}

			{destinations.data && destinations.data.length === 0 ? (
				<EmptyState
					icon={BellRing}
					title="No destinations"
					description={
						may("add")
							? "OpenMCC has no way to reach you when a machine stops responding or a bot cannot rejoin. Add a destination to start receiving alerts."
							: "OpenMCC has no way to reach you when a machine stops responding or a bot cannot rejoin."
					}
					action={
						may("add") ? (
							<Button size="sm" onClick={() => setAdding(true)}>
								<Plus className="size-4" />
								Add destination
							</Button>
						) : undefined
					}
				/>
			) : null}

			<div className="space-y-3">
				{destinations.data?.map((destination) => (
					<div
						key={destination.id}
						className="rounded-[var(--radius)] border border-border bg-card p-4"
					>
						<div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
							<div className="min-w-0 flex-1 basis-56 space-y-1">
								<div className="flex flex-wrap items-center gap-2">
									<span className="min-w-0 break-words font-medium text-foreground">
										{destination.name}
									</span>
									<Badge variant="outline">{destination.kindLabel}</Badge>
									{destination.enabled ? null : <Badge variant="secondary">Off</Badge>}
								</div>
								<div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
									<span className="truncate">{destination.target}</span>
									{sharedTargets.has(destination.target) &&
									destination.targetFingerprint !== null ? (
										<span className="rounded border border-border px-1.5 py-0.5 font-mono text-[11px]">
											{destination.targetFingerprint}
										</span>
									) : null}
									{destination.signingKeyHint === null ? null : (
										<span className="inline-flex items-center gap-1 rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[11px]">
											<KeyRound className="size-3" />
											{destination.signingKeyHint}
										</span>
									)}
									{destination.kind === "webhook" ? (
										<button
											type="button"
											onClick={() => setExplaining(true)}
											className="underline underline-offset-4 transition-colors hover:text-foreground"
										>
											How it works
										</button>
									) : null}
								</div>
								<p className="text-xs text-muted-foreground">
									{destination.lastFailureReason === null ? (
										<span className="inline-flex items-center gap-1">
											<CircleCheck className="size-3" />
											Last delivered {whenLast(destination.lastSucceededAt)}
										</span>
									) : (
										<span className="inline-flex items-center gap-1 text-destructive">
											<CircleAlert className="size-3" />
											{destination.lastFailureReason} — {whenLast(destination.lastFailedAt)}
										</span>
									)}
								</p>
							</div>
							<div className="flex flex-wrap items-center gap-2">
								{may("edit") && canBeCreated(destination.kind) ? (
									<Button
										size="sm"
										variant="outline"
										onClick={() => setPendingEdit(destination.id)}
									>
										<Pencil className="size-4" />
										Edit
									</Button>
								) : null}
								{may("test") ? (
									<Button
										size="sm"
										variant="outline"
										onClick={() => {
											test.mutate(
												{ destinationId: destination.id },
												{ onSuccess: (result) => setTesting(result.deliveryId) },
											)
										}}
									>
										<Send className="size-4" />
										Test
									</Button>
								) : null}
								{may("enable") ? (
									<Button
										size="sm"
										variant="outline"
										onClick={() => {
											if (destination.enabled) {
												setPendingDisable(destination.id)
												return
											}
											setEnabled.mutate(
												{ destinationId: destination.id, enabled: true },
												{ onSuccess: refresh },
											)
										}}
									>
										{destination.enabled ? "Disable" : "Enable"}
									</Button>
								) : null}
								{may("rotate") && destination.kind === "webhook" ? (
									<Button
										size="sm"
										variant="outline"
										onClick={() => setPendingRotate(destination.id)}
									>
										Rotate signing key
									</Button>
								) : null}
								{may("remove") ? (
									<Button
										size="sm"
										variant="ghost"
										onClick={() => setPendingDelete(destination.id)}
									>
										<Trash2 className="size-4" />
									</Button>
								) : null}
							</div>
						</div>
						<div className="mt-3 flex flex-wrap gap-1.5">
							{destination.subscribedTo.map((alert) => (
								<Badge key={alert} variant="secondary">
									{SUBSCRIPTION_LABELS[alert]}
								</Badge>
							))}
						</div>
					</div>
				))}
			</div>

			{failures.data && failures.data.length > 0 ? (
				<section className="space-y-2">
					<h2 className="text-sm font-medium text-foreground">Alerts that did not arrive</h2>
					<div className="divide-y divide-border rounded-[var(--radius)] border border-border bg-card">
						{failures.data.map((failure) => (
							<div key={failure.deliveryId} className="flex items-start justify-between gap-4 p-3">
								<div className="min-w-0 space-y-0.5">
									<p className="truncate text-sm text-foreground">{failure.title}</p>
									<p className="text-xs text-muted-foreground">
										{failure.destinationName}
										{failure.reason === null ? null : ` — ${failure.reason}`}
										{failure.attempts > 1 ? ` · ${failure.attempts} attempts` : null}
									</p>
								</div>
								<div className="flex shrink-0 items-center gap-2">
									{may("sendAgain") ? (
										<Button
											size="sm"
											variant="outline"
											disabled={retry.isPending}
											onClick={() =>
												retry.mutate({ deliveryId: failure.deliveryId }, { onSuccess: refresh })
											}
										>
											Send again
										</Button>
									) : null}
									{may("dismiss") ? (
										<Button
											size="sm"
											variant="ghost"
											disabled={dismiss.isPending}
											onClick={() =>
												dismiss.mutate({ deliveryId: failure.deliveryId }, { onSuccess: refresh })
											}
										>
											Dismiss
										</Button>
									) : null}
								</div>
							</div>
						))}
					</div>
				</section>
			) : null}

			<Modal open={adding} onClose={() => setAdding(false)} title="Add destination" size="wider">
				<AlertDestinationForm
					submitLabel="Add"
					pending={create.isPending}
					onSubmit={handleCreate}
					onExplainWebhook={() => setExplaining(true)}
				/>
			</Modal>

			<Modal
				open={editing !== undefined}
				onClose={() => setPendingEdit(undefined)}
				title="Edit destination"
				description="OpenMCC never shows an address or token back, so enter it again to save."
				size="wider"
			>
				{editing === undefined || !canBeCreated(editing.kind) ? null : (
					<AlertDestinationForm
						key={editing.id}
						submitLabel="Save"
						pending={edit.isPending}
						initial={draftFor(editing.kind, editing.name, editing.subscribedTo)}
						onSubmit={(draft) =>
							edit.mutate(
								{ destinationId: editing.id, ...draft },
								{
									onSuccess: () => {
										setPendingEdit(undefined)
										refresh()
									},
								},
							)
						}
						onExplainWebhook={() => setExplaining(true)}
					/>
				)}
			</Modal>

			<Modal
				open={explaining}
				onClose={() => setExplaining(false)}
				title="How webhook alerts work"
				description="What OpenMCC sends, how to verify it, and what it expects back."
				size="wide"
			>
				<WebhookContract />
			</Modal>

			<Modal
				open={revealed !== undefined}
				onClose={() => setRevealed(undefined)}
				title="Signing key"
			>
				<div className="space-y-3">
					<p className="text-sm text-muted-foreground">
						Give this to the service receiving these alerts so it can verify they came from OpenMCC.
						It will not be shown again.
					</p>
					<div className="flex items-center gap-2 rounded-[var(--radius)] border border-border bg-muted p-3">
						<code className="min-w-0 flex-1 break-all font-mono text-xs">{revealed}</code>
						<CopyButton value={revealed ?? ""} label="Copy signing key" />
					</div>
					<div className="flex justify-end">
						<Button onClick={() => setRevealed(undefined)}>Done</Button>
					</div>
				</div>
			</Modal>

			<ConfirmDialog
				open={pendingRotate !== undefined}
				title="Issue a new signing key?"
				description="The current key keeps working for 24 hours, then stops. Anything receiving these alerts must be given the new key before then, or it will start rejecting them."
				confirmLabel="Issue new key"
				busy={rotate.isPending}
				onCancel={() => setPendingRotate(undefined)}
				onConfirm={() => {
					if (!pendingRotate) return
					rotate.mutate(
						{ destinationId: pendingRotate },
						{
							onSuccess: (result) => {
								setPendingRotate(undefined)
								setRevealed(result.signingSecret)
								refresh()
							},
						},
					)
				}}
			/>

			<ConfirmDialog
				open={pendingDisable !== undefined}
				title="Turn this destination off?"
				description="OpenMCC will stop sending alerts here, and anything already queued for it is discarded. You can turn it back on at any time."
				confirmLabel="Turn off"
				busy={setEnabled.isPending}
				onCancel={() => setPendingDisable(undefined)}
				onConfirm={() => {
					if (!pendingDisable) return
					setEnabled.mutate(
						{ destinationId: pendingDisable, enabled: false },
						{
							onSuccess: () => {
								setPendingDisable(undefined)
								refresh()
							},
						},
					)
				}}
			/>

			<ConfirmDialog
				open={pendingDelete !== undefined}
				title="Remove this destination?"
				description="OpenMCC will stop sending alerts to this destination. Anything already queued is discarded."
				confirmLabel="Remove"
				destructive
				busy={remove.isPending}
				onCancel={() => setPendingDelete(undefined)}
				onConfirm={() => {
					if (!pendingDelete) return
					remove.mutate(
						{ destinationId: pendingDelete },
						{
							onSuccess: () => {
								setPendingDelete(undefined)
								refresh()
							},
						},
					)
				}}
			/>
		</div>
	)
}
