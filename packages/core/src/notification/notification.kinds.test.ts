import { readdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import type {
	AttemptOutcome as ContractAttemptOutcome,
	DeliveryState as ContractDeliveryState,
	DestinationKind as ContractDestinationKind,
	NotificationKind as ContractNotificationKind,
	SubscriptionKind as ContractSubscriptionKind,
} from "@open-mcc/contracts"
import {
	ATTEMPT_OUTCOMES,
	DELIVERY_STATES,
	DESTINATION_KINDS,
	NOTIFICATION_KINDS,
	SUBSCRIPTION_KINDS,
} from "@open-mcc/contracts"
import type {
	AttemptOutcome as DbAttemptOutcome,
	DeliveryState as DbDeliveryState,
	DestinationKind as DbDestinationKind,
	NotificationKind as DbNotificationKind,
	SubscriptionKind as DbSubscriptionKind,
} from "@open-mcc/db"
import { describe, expect, it } from "vitest"

type RefinementOf<Narrowed extends Base, Base> = Narrowed

type _DbDestinationKindIsAContractKind = RefinementOf<DbDestinationKind, ContractDestinationKind>
type _ContractDestinationKindIsADbKind = RefinementOf<ContractDestinationKind, DbDestinationKind>

type _DbSubscriptionKindIsAContractKind = RefinementOf<DbSubscriptionKind, ContractSubscriptionKind>
type _ContractSubscriptionKindIsADbKind = RefinementOf<ContractSubscriptionKind, DbSubscriptionKind>

type _DbNotificationKindIsAContractKind = RefinementOf<DbNotificationKind, ContractNotificationKind>
type _ContractNotificationKindIsADbKind = RefinementOf<ContractNotificationKind, DbNotificationKind>

type _DbDeliveryStateIsAContractState = RefinementOf<DbDeliveryState, ContractDeliveryState>
type _ContractDeliveryStateIsADbState = RefinementOf<ContractDeliveryState, DbDeliveryState>

type _DbAttemptOutcomeIsAContractOutcome = RefinementOf<DbAttemptOutcome, ContractAttemptOutcome>
type _ContractAttemptOutcomeIsADbOutcome = RefinementOf<ContractAttemptOutcome, DbAttemptOutcome>

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), "../../../db/migrations")

const CHECK_LIST = /CONSTRAINT\s+"([^"]+)"\s+CHECK\s*\(\s*"[^"]+"\s+IN\s*\(([^)]*)\)\s*\)/g

const acceptedValues = (): ReadonlyMap<string, readonly string[]> => {
	const accepted = new Map<string, readonly string[]>()
	for (const file of readdirSync(MIGRATIONS).sort()) {
		const sql = readFileSync(join(MIGRATIONS, file), "utf8")
		for (const [, constraint, list] of sql.matchAll(CHECK_LIST)) {
			if (constraint === undefined || list === undefined) continue
			accepted.set(
				constraint,
				[...list.matchAll(/'([^']*)'/g)].map(([, value]) => value ?? ""),
			)
		}
	}
	return accepted
}

const accepts = (constraint: string): readonly string[] => {
	const values = acceptedValues().get(constraint)
	if (values === undefined) throw new Error(`no migration declares ${constraint}`)
	return [...values].sort()
}

const listed = (values: readonly string[]): readonly string[] => [...values].sort()

describe("the kinds the database is willing to store", () => {
	it("takes exactly the destination kinds the contracts offer", () => {
		expect(accepts("notificationDestination_kind_known")).toEqual(listed(DESTINATION_KINDS))
	})

	it("takes exactly the alerts an operator can subscribe to", () => {
		expect(accepts("notificationSubscription_kind_known")).toEqual(listed(SUBSCRIPTION_KINDS))
	})

	it("takes exactly the notification kinds the producer can plan", () => {
		expect(accepts("notification_kind_known")).toEqual(listed(NOTIFICATION_KINDS))
	})

	it("takes exactly the delivery states a delivery moves through", () => {
		expect(accepts("notificationDelivery_state_known")).toEqual(listed(DELIVERY_STATES))
	})

	it("takes exactly the outcomes an attempt can end in", () => {
		expect(accepts("notificationAttempt_outcome_known")).toEqual(listed(ATTEMPT_OUTCOMES))
	})

	it("names every accepted value once, so a set comparison cannot hide a duplicate", () => {
		for (const [constraint, values] of acceptedValues()) {
			expect(new Set(values).size, constraint).toBe(values.length)
		}
	})
})
