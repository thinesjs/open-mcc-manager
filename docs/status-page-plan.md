# Status page and the event pipeline

## Why this exists twice over

The owner asked for connection audits, a disruptive-event log, uptime and retention.
Separately, `docs/notifications-plan.md` stalled because nothing durably records that a
host *became* unreachable. These are the same thing. One pipeline serves both, and
notifications consume canonical events rather than polling for themselves.

## Two claims that were wrong, and are load-bearing

**`lastExitCode` is never written.** The interpreter exists
(`packages/core/src/instance/exit-code.ts` knows 0/2/3/4), the column is writable, and
the dashboard displays it — but **no production caller sets it**. Exits are not detected
at all today without a new poll. "We already record disruption" was false.

**`mcc_recent_events` cannot be a source of record.** Verified against the deployed tag
`20260829-511`: the client appends the disconnect and then immediately stops the
live host and clears its stores, so the entry is normally gone before the next read.
its event store is a 500-entry ring trimmed from the front, and the controller calls
it with no persisted `afterId`, so every poll restarts from zero. It may *corroborate* an
event; it must never create or close uptime.

The real evidence is: current process state, incrementally read exit records via the
existing user-manager `journalctl` helper, successful session-status reads, host
probe outcomes, and periodic reconciliation.

## Model

Five tables, all organization-scoped with composite foreign keys, all `text` unions owned
by `packages/contracts/src/status.ts`, no Postgres enums.

- `statusEvent` — the canonical ledger. Carries `occurredAt` and `observedAt` separately,
  an `incidentId` grouping an interruption with its recovery, a `primarySource`, a
  `sources` array for corroboration, and a partial-unique `sourceKey` for replay safety.
  Keeps `subjectId`/`subjectLabel` so history survives the resource being deleted.
- `statusCondition` — one mutable row per subject and dimension. Updated on every poll,
  writes history only on change. Dimensions: host reachability, host service health, host
  drift, instance process, instance connection, instance drift.
- `statusInterval` — transition history. A change closes one interval and opens the next in
  one transaction; a partial unique index allows only one open interval per dimension.
- `statusDailyRollup` — good/bad/degraded/unknown/excluded seconds per UTC day.
- `statusSourceCursor` — durable journal cursor plus generation.

**Deduplication is by open incident, not by time bucket.** A process exit opens an incident;
a later failed live read or matching MCC event joins it as corroboration rather than
inserting a second disruption. The notification cooldown is a delivery concern and must
never erase a real event.

## Uptime, honestly

Transitions, never samples, so row growth is bounded.

*Hosts* measure reachability. One failed probe is `suspect`, not down; three minutes of
failure is `down`. `failedUnits > 0` is a separate degraded condition and is not downtime.

*Instances* have **one** metric that counts: **connected** — proven joined to the
Minecraft server as a player. The owner's rule is explicit:

> The status of the bot is green **only** when it has joined the server as a player.

A running process is not green. "Running but never joined" is not green. Client-running
state is still tracked, because it is what distinguishes *why* a bot is not connected, but
it is secondary detail and never the headline colour.

A failed live read with no exit evidence is `unknown`, not disconnected — the read channel
itself may have failed. Sleep windows are `excluded` from the denominator, evaluated in
their stored timezone.

`suspect`, gaps and unmonitored periods never count as uptime. Every range returns
uptime **and coverage**; the page must never print "100%" without coverage beside it, and
must never join two known-good intervals across a gap.

## Retention, in three tiers

| Data | Kept | Why |
| --- | ---: | --- |
| `statusEvent` | 30 days | Grows fastest, useful only for recent diagnosis |
| `statusInterval` | 90 days | Exact recent timelines |
| `statusDailyRollup` | 760 days | Two years plus boundary margin |
| `statusCondition`, `statusSourceCursor` | resource lifetime | Small, current-state only |

Daily maintenance on a `status.maintenance` pg-boss queue, carrying `{ organizationId }` so
every call stays organization-scoped: roll up closed days, verify a day was rolled before
deleting its intervals, then delete by tier. Idempotent, so pg-boss may retry.

Budget at 1,000 instances: ~3.7M retained rows, roughly 1.8-3.7 GiB with indexes. Measure
with `pg_total_relation_size` before raising any constant. Persisting raw gameplay events
would invalidate this budget entirely, which is the other reason the ring is not a source.

## Stages

1. **Durable host status**, useful alone: the five tables, contracts, repository,
   controller, the health poller writing both success *and* failure, rollups, the
   maintenance job, a `status` router, and `/status` showing host uptime, coverage gaps and
   incidents.
2. **Process exits and honest bot uptime**: a journal boundary parser, an instance observer
   over the already-open transport, `lastExitCode` finally written from a replay-safe
   source, sleep-window exclusion, and the connection/process cards.
3. **Durable drift** on a five-minute background reconcile, then the notification handoff.

## Resolved: the live channel does not have to be mandatory

The plan originally proposed forcing `McpServer.Enabled` and `Capabilities.SessionStatus`
on for every instance, because connected uptime looked unmeasurable without them. It is
not. **The console already states joined-ness unambiguously**, and this repo already knows
the marker — `JOINED_MARKER = "Server was successfully joined"` in
`packages/core/src/instance/reconcile.ts:38`, already used at line 277 to build a joined
set.

Confirmed against a real instance's journal, including a full drop-and-rejoin:

```
14:15:38  [MCC] Disconnected by Server :
14:15:38  [MCC] Kicked by an operator
14:16:10  [MCC] Server was successfully joined.     <- new process id
```

So the connection state machine closes on journal evidence alone: a join marker opens a
connected interval, a `Disconnected by Server` closes it, the following line carries the
reason, and a changed process id marks the restart. The kick reason is available for the
event copy without any live channel at all.

The live channel therefore stays **optional**. Where an operator has enabled it, a
successful `mcc_session_status` read *corroborates* connected state and shortens detection
latency. Where they have not, connected uptime still works. No capability is forced on
anyone, and no existing bot has to be restarted to get history.
