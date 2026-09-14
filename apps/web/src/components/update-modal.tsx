import {
	type ReleaseNoteBlock,
	type ReleaseNoteSpan,
	type ReleaseNotesView,
	releasePageUrl,
	type UpdateStatus,
} from "@open-mcc/contracts"
import { useQuery } from "@tanstack/react-query"
import { useState } from "react"
import { Button } from "~/components/ui/button"
import { Modal } from "~/components/ui/modal"
import { LoadingBlock } from "~/components/ui/spinner"
import { Tooltip } from "~/components/ui/tooltip"
import { useTRPC } from "~/lib/trpc"
import { checkedAgo, checkFailureReason, RELEASE_NOTES_SHOWN_FIRST } from "~/lib/update-status"

export type OpenableUpdateStatus = Exclude<UpdateStatus, { kind: "development" }>

const shortTime = (at: Date): string =>
	at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })

export const headlineOf = (status: OpenableUpdateStatus): string => {
	if (status.kind === "unchecked") return "Updates"
	if (status.available) return "Update available"
	if (status.latest !== null) return "Up to date"
	if (status.outcome === "not-found") return "No release found"
	return "Update check failed"
}

const Span = ({ span }: { span: ReleaseNoteSpan }) => {
	if (span.kind === "bold") return <strong className="font-semibold">{span.text}</strong>
	if (span.kind === "italic") return <em>{span.text}</em>
	if (span.kind === "code") {
		return <code className="rounded-sm bg-muted px-1 font-mono text-xs">{span.text}</code>
	}
	if (span.kind === "link") {
		return (
			<span>
				{span.label} <span className="text-muted-foreground">({span.url})</span>
			</span>
		)
	}
	return <span>{span.text}</span>
}

const Spans = ({ spans }: { spans: readonly ReleaseNoteSpan[] }) => (
	<>
		{spans.map((span) => (
			<Span key={span.start} span={span} />
		))}
	</>
)

const NoteBlock = ({ block }: { block: ReleaseNoteBlock }) => {
	if (block.kind === "code") {
		return (
			<pre className="overflow-x-auto rounded-sm bg-muted p-2 font-mono text-xs">
				<code>{block.text}</code>
			</pre>
		)
	}
	if (block.kind === "heading") {
		return (
			<p className="font-semibold">
				<Spans spans={block.spans} />
			</p>
		)
	}
	if (block.kind === "bullet" || block.kind === "numbered") {
		return (
			<p className="flex gap-2">
				<span className="shrink-0 text-muted-foreground">
					{block.kind === "numbered" ? `${block.number}.` : "•"}
				</span>
				<span className="min-w-0 whitespace-pre-wrap">
					<Spans spans={block.spans} />
				</span>
			</p>
		)
	}
	return (
		<p className="whitespace-pre-wrap">
			<Spans spans={block.spans} />
		</p>
	)
}

export const ReleaseNotes = ({ notes }: { notes: ReleaseNotesView }) => {
	const [showAll, setShowAll] = useState(false)
	const shown = showAll ? notes.blocks : notes.blocks.slice(0, RELEASE_NOTES_SHOWN_FIRST)
	const page = releasePageUrl(notes.source, notes.version)

	return (
		<section className="space-y-2">
			<p className="text-xs text-muted-foreground">
				Release notes from {notes.source.owner}/{notes.source.repo}
			</p>
			{shown.length > 0 ? (
				<div
					data-slot="release-notes"
					className="max-h-[50vh] space-y-2 overflow-y-auto break-words rounded-[var(--control-radius)] border border-border p-3 text-sm text-foreground"
				>
					{shown.map((block) => (
						<NoteBlock key={block.start} block={block} />
					))}
				</div>
			) : null}
			{!showAll && notes.blocks.length > RELEASE_NOTES_SHOWN_FIRST ? (
				<Button variant="ghost" size="xs" onClick={() => setShowAll(true)}>
					Show all
				</Button>
			) : null}
			<p className="text-xs text-muted-foreground">
				{notes.truncated ? "Notes truncated — " : null}
				<a
					href={page}
					target="_blank"
					rel="noreferrer"
					className="text-foreground underline underline-offset-4"
				>
					{notes.truncated ? "view on GitHub" : "View on GitHub"}
				</a>
			</p>
		</section>
	)
}

const ReleaseNotesFor = ({ enabled }: { enabled: boolean }) => {
	const trpc = useTRPC()
	const notes = useQuery({ ...trpc.system.releaseNotes.queryOptions(), enabled, retry: false })
	if (notes.isPending) return <LoadingBlock label="Reading release notes" />
	if (!notes.data) return null
	return <ReleaseNotes notes={notes.data} />
}

const UpdateDetail = ({ status, open }: { status: OpenableUpdateStatus; open: boolean }) => {
	if (status.kind === "unchecked") return <LoadingBlock label="Checking" />

	const checked = `checked ${checkedAgo(new Date(status.checkedAt), new Date())}`
	const rateLimitedUntil =
		status.rateLimitedUntil === null ? null : new Date(status.rateLimitedUntil)
	const reason =
		status.outcome === "ok" ? null : checkFailureReason(status.outcome, rateLimitedUntil, shortTime)

	return (
		<div className="space-y-4">
			<p className="text-sm text-foreground">
				{status.available && status.latest !== null
					? `${status.latest} · you are on ${status.running}`
					: `${status.running} · ${checked}`}
			</p>
			{reason !== null && status.latest === null ? (
				<p className="text-sm text-muted-foreground">{reason}</p>
			) : null}
			{reason !== null && status.latest !== null ? (
				<p className="text-sm text-muted-foreground">
					<Tooltip content={reason}>Last check failed</Tooltip>
				</p>
			) : null}
			{status.available ? <ReleaseNotesFor enabled={open} /> : null}
		</div>
	)
}

export type UpdateModalProps = {
	open: boolean
	onClose: () => void
}

export const UpdateModal = ({ open, onClose }: UpdateModalProps) => {
	const trpc = useTRPC()
	const update = useQuery({ ...trpc.system.updateStatus.queryOptions(), retry: false })
	const status = update.data
	if (!status || status.kind === "development") return null

	return (
		<Modal open={open} onClose={onClose} title={headlineOf(status)} size="wide">
			<UpdateDetail status={status} open={open} />
		</Modal>
	)
}
