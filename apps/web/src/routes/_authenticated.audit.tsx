import { AUDIT_PAGE_SIZE, type AuditEventView, can } from "@open-mcc/contracts"
import { keepPreviousData, useQuery, useSuspenseQuery } from "@tanstack/react-query"
import { createFileRoute } from "@tanstack/react-router"
import { CircleAlert, ScrollText } from "lucide-react"
import { useEffect, useState } from "react"
import { EmptyState } from "~/components/empty-state"
import { Alert } from "~/components/ui/alert"
import { Button } from "~/components/ui/button"
import { PageLoading } from "~/components/ui/shimmer"
import { Tooltip } from "~/components/ui/tooltip"
import { describeAuditEvent } from "~/lib/audit-events"
import { auditNextDisabled, auditPagerVisible, lastAuditOffset } from "~/lib/audit-paging"
import { getErrorMessage } from "~/lib/errors"
import { useTRPC } from "~/lib/trpc"

export const Route = createFileRoute("/_authenticated/audit")({
	component: AuditPage,
})

const detailOf = (event: AuditEventView): string =>
	Object.entries(event.detail)
		.map(([key, value]) => `${key}: ${value}`)
		.join(" · ")

const Sentence = ({ event }: { event: AuditEventView }) => {
	const sentence = describeAuditEvent(event)
	const detail = detailOf(event)
	if (detail.length === 0) return <span className="text-sm text-foreground">{sentence}</span>
	return (
		<span className="text-sm text-foreground">
			<Tooltip content={detail}>{sentence}</Tooltip>
		</span>
	)
}

function AuditPage() {
	const trpc = useTRPC()
	const [offset, setOffset] = useState(0)
	const me = useSuspenseQuery(trpc.member.me.queryOptions())
	const mayRead = can(me.data.role, "audit.read")
	const page = useQuery({
		...trpc.audit.list.queryOptions({ offset }),
		enabled: mayRead,
		placeholderData: keepPreviousData,
	})

	const total = page.data?.total

	useEffect(() => {
		if (total === undefined) return
		const lastPage = lastAuditOffset(total)
		if (offset > lastPage) setOffset(lastPage)
	}, [total, offset])
	const staleWarning = me.isError ? (
		<Alert variant="error" icon={<CircleAlert />}>
			{getErrorMessage(me.error)}
		</Alert>
	) : null

	const header = (
		<div>
			<h1 className="text-lg font-semibold text-foreground">Audit log</h1>
			{total === undefined ? null : (
				<p className="text-sm text-muted-foreground">
					{total === 1 ? "1 action recorded" : `${total} actions recorded`}
				</p>
			)}
		</div>
	)

	if (!mayRead) {
		return (
			<div className="space-y-6">
				{header}
				{staleWarning}
				<p className="text-sm text-muted-foreground">Only owners can read the audit log.</p>
			</div>
		)
	}

	return (
		<div className="space-y-6">
			{header}

			{staleWarning}

			{page.isPending ? <PageLoading label="Loading audit log" /> : null}

			{page.isError ? (
				<Alert variant="error" icon={<CircleAlert />}>
					{getErrorMessage(page.error)}
				</Alert>
			) : null}

			{page.data && page.data.items.length === 0 ? (
				<EmptyState
					icon={ScrollText}
					title="Nothing recorded yet"
					description="Changes to hosts, instances, keys and members are recorded here as they happen."
				/>
			) : null}

			{page.data && page.data.items.length > 0 ? (
				<ul className="divide-y divide-border overflow-hidden rounded-[var(--radius)] border border-border bg-card">
					{page.data.items.map((event) => (
						<li key={event.id} className="flex items-baseline justify-between gap-4 px-4 py-3">
							<Sentence event={event} />
							<time dateTime={event.createdAt} className="shrink-0 text-xs text-muted-foreground">
								{new Date(event.createdAt).toLocaleString()}
							</time>
						</li>
					))}
				</ul>
			) : null}

			{page.data && auditPagerVisible(page.data.total, offset) ? (
				<div className="flex items-center justify-end gap-2">
					<Button
						variant="outline"
						size="sm"
						disabled={offset === 0}
						onClick={() => setOffset(Math.max(0, offset - AUDIT_PAGE_SIZE))}
					>
						Previous
					</Button>
					<Button
						variant="outline"
						size="sm"
						disabled={auditNextDisabled(page.data.total, offset, page.data.items.length)}
						onClick={() => setOffset(offset + AUDIT_PAGE_SIZE)}
					>
						Next
					</Button>
				</div>
			) : null}
		</div>
	)
}
