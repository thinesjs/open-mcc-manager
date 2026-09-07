import { type Capability, can, type DeliveryState, type Role } from "@open-mcc/contracts"

export const ALERT_CONTROLS = [
	"list",
	"add",
	"edit",
	"test",
	"enable",
	"rotate",
	"remove",
	"sendAgain",
	"dismiss",
] as const

export type AlertControl = (typeof ALERT_CONTROLS)[number]

const NEEDED: Record<AlertControl, Capability> = {
	list: "notification.read",
	add: "notification.manage",
	edit: "notification.manage",
	test: "notification.manage",
	enable: "notification.manage",
	rotate: "notification.manage",
	remove: "notification.manage",
	sendAgain: "notification.manage",
	dismiss: "notification.manage",
}

export const mayUseAlertControl = (role: Role | undefined, control: AlertControl): boolean =>
	role !== undefined && can(role, NEEDED[control])

export const TEST_POLL_INTERVAL_MS = 2_000

export const TEST_POLL_BUDGET_MS = 60_000

export type TestProgress = {
	readonly state: DeliveryState | undefined
	readonly reason: string | null
	readonly gaveUp: boolean
}

export type TestOutcome =
	| { readonly kind: "sending" }
	| { readonly kind: "arrived" }
	| { readonly kind: "did-not-arrive"; readonly reason: string | null }
	| { readonly kind: "still-sending" }

export const testOutcomeOf = (progress: TestProgress): TestOutcome => {
	if (progress.state === "delivered") return { kind: "arrived" }
	if (progress.state === "failed" || progress.state === "abandoned") {
		return { kind: "did-not-arrive", reason: progress.reason }
	}
	return progress.gaveUp ? { kind: "still-sending" } : { kind: "sending" }
}

export const shouldKeepPolling = (progress: TestProgress): boolean =>
	testOutcomeOf(progress).kind === "sending"

const TEST_OUTCOME_MESSAGES: Record<TestOutcome["kind"], string> = {
	sending: "Sending a test alert.",
	arrived: "The test alert arrived.",
	"did-not-arrive": "The test alert did not arrive.",
	"still-sending": "Still sending. If it fails it will show below.",
}

export const describeTestOutcome = (outcome: TestOutcome): string =>
	outcome.kind === "did-not-arrive" && outcome.reason !== null
		? `${TEST_OUTCOME_MESSAGES[outcome.kind]} ${outcome.reason}`
		: TEST_OUTCOME_MESSAGES[outcome.kind]
