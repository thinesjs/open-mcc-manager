import {
	isNotifyingEvent,
	NOTIFICATION_KINDS,
	type NotificationKind,
	notificationCopy,
	problemResolvedBy,
	type StatusEventKind,
} from "@open-mcc/contracts"

export type EventFact = {
	readonly statusEventId: string
	readonly kind: StatusEventKind
	readonly subjectType: "host" | "instance"
	readonly subjectId: string
	readonly subjectName: string
}

export type PlannedNotification = {
	readonly kind: NotificationKind
	readonly title: string
	readonly body: string
	readonly subjectType: "host" | "instance"
	readonly subjectId: string
	readonly dedupeKey: string
	readonly sourceStatusEventId: string
}

export const dedupeKeyFor = (statusEventId: string): string => `event:${statusEventId}`

export const subscriptionKindFor = (kind: StatusEventKind): StatusEventKind =>
	problemResolvedBy(kind) ?? kind

const asNotificationKind = (kind: StatusEventKind): NotificationKind | undefined =>
	NOTIFICATION_KINDS.find((candidate) => candidate === kind)

export const relevantKinds = (kind: StatusEventKind): readonly NotificationKind[] => {
	const problem = problemResolvedBy(kind)
	const resolved = problem === undefined ? undefined : asNotificationKind(problem)
	const self = asNotificationKind(kind)
	return [resolved, self].flatMap((candidate) => (candidate === undefined ? [] : [candidate]))
}

export const worthAnnouncing = (
	kind: StatusEventKind,
	lastAnnouncedKind: string | undefined,
): boolean => {
	const problem = problemResolvedBy(kind)
	if (problem !== undefined) return lastAnnouncedKind === problem
	return isNotifyingEvent(kind)
}

export type LastAnnounced = (
	subjectType: "host" | "instance",
	subjectId: string,
	kinds: readonly NotificationKind[],
) => Promise<string | undefined>

export const planNotification = async (
	fact: EventFact,
	lastAnnounced: LastAnnounced,
): Promise<PlannedNotification | undefined> => {
	const kind = asNotificationKind(fact.kind)
	if (kind === undefined) return undefined

	const previous =
		problemResolvedBy(fact.kind) === undefined
			? undefined
			: await lastAnnounced(fact.subjectType, fact.subjectId, relevantKinds(fact.kind))

	if (!worthAnnouncing(fact.kind, previous)) return undefined

	const copy = notificationCopy(kind, { name: fact.subjectName })
	return {
		kind,
		title: copy.title,
		body: copy.body,
		subjectType: fact.subjectType,
		subjectId: fact.subjectId,
		dedupeKey: dedupeKeyFor(fact.statusEventId),
		sourceStatusEventId: fact.statusEventId,
	}
}
