# Alerts: making the alerts real, then the settings page

The delivery machinery is committed and tested. Nothing can reach it: there is no way to
create a destination, and two of the eight subscribable events cannot fire at all. This
slice closes both. The order matters — the page comes last, because a page offering alerts
that cannot fire is a lie told in the product's own UI.

## Part one: the two events that cannot happen

### `instance.disconnected`

`escalateIfStillDown` is a pure time check. It cannot run in response to another journal
event, because a bot that goes down and never comes back produces no further events. It
needs a timer, and the timer must be durable — a process restart must not lose it.

A **delayed job**, not a periodic sweep:

1. When the controller records a loss it assigns a **new `activeIncidentId`** and, in the
   same transaction, schedules an escalation job for the end of the grace period.
2. The job re-reads the condition and escalates **only if it is still interrupted and still
   carries the same incident id**.
3. A rejoin clears the incident id, so the job wakes to find nothing to do and stops.
4. Recording the event, updating the condition, announcing and enqueueing stay one
   transaction, exactly as `announce` already requires.

`activeIncidentId` exists in the condition table but instance connection handling **writes
it as `null` every time** and records events with no incident id. That changes here; without
it, step 2 has nothing to compare and the escalation cannot be made idempotent.

**Re-reading is not enough.** Two escalation jobs for one incident — a retry, a restart, a
duplicate enqueue — can both read the same state before either writes, and both would
announce. The guard has to be the database, not the read:

`statusEvent` already carries a partial unique index on
`(organizationId, primarySource, sourceKey)`, and `recordEvent` inserts with
`ON CONFLICT DO NOTHING`. The escalation therefore records its event with a **deterministic**
`sourceKey` of `escalate:<incidentId>` — stable across duplicate jobs, unlike the
timestamp-bearing keys the observer writes. The loser's insert returns no row, `announce` is
never reached, and nothing is sent twice. The uniqueness is enforced by Postgres, so the race
cannot be lost.

The observer keeps translating journal signals and does **not** own the timer: it runs only
after a host was reached, so a host that is itself unreachable would never tick it.

### `instance.flapping`

`isFlapping` returns true on the fifth loss in the window — and on the sixth, and the
seventh. Without suppression it would alert on every loss thereafter. It needs **durable
once-per-window state**, and again a read-then-write would race: two concurrent losses could
both see no recent alert.

So the alert is **claimed, not checked**. A new `lastFlappedAt` column on the condition, and
a single conditional update:

```
UPDATE "statusCondition" SET "lastFlappedAt" = :now
WHERE "organizationId" = :organizationId AND "id" = :id
  AND ("lastFlappedAt" IS NULL OR "lastFlappedAt" <= :now - interval '30 minutes')
```

The `organizationId` predicate is not decoration: every repository operation here is
tenant-scoped, and a claim that reached across organizations would be the one place the rule
was quietly dropped. **Only an affected-row count of exactly one may announce.** A loser
updates nothing and stays quiet. This needs a migration, so `migrate` and `worker` images are
rebuilt with it.

**Both `instance.connection_lost` and `instance.kicked` count as losses.** That is the
owner's rule stated exactly: a kick alone stays quiet and the bot just reconnects, but kicks
that keep happening are what flapping is for.

### Recovery correlation becomes incident-scoped

Today a recovery asks whether the problem was the last thing announced about the subject.
With incident ids present, it should ask whether the problem was announced **for this
incident**. Same behaviour in the simple case, correct in the case where two incidents
overlap a single subject.

Each of these needs a test for the quiet case, not just the loud one. A rejoin inside the
grace period, a fifth loss followed by a sixth, a kick on its own — these are what drive an
operator to switch alerts off entirely.

## Part two: what an operator can do

### Two capabilities, not one

- **`notification.read`** — operators. Which destinations exist, whether they are working,
  when they last worked or failed, and why. Operators already start, stop and reconfigure
  bots; whether the alerting for those bots is working is part of that job.
- **`notification.manage`** — owners only. Create, edit, rotate, test, enable, disable,
  delete. These touch sealed credentials.

The read model never exposes sealed configuration, so the secret-based argument for
withholding it from operators does not apply.

### Only the two kinds that can actually send

Contracts define nine destination kinds; dispatch implements **webhook and Telegram**. Those
two are all that can be created — and the restriction is enforced **server-side, in the
creation and edit contract and again in the controller**, not merely hidden in the page. A
direct API client must be refused too, or it can store a destination that dispatch will
reject at delivery time and which will sit there failing.

Offering a kind that cannot send is the same lie as offering an alert that cannot fire. The
remaining seven land when their senders do.

### The signing secret

Generated by us, never supplied. Returned **exactly once**, at creation or at rotation.
There is no reveal endpoint: every later authenticated read would otherwise be a chance to
lift the receiver's credential, and that contradicts the sealed-config boundary the rest of
the design rests on.

**`rotate` is a first-class operation**, audited: issue a new secret, keep the previous one
valid for the fixed overlap already in contracts, return the new one once. Losing a secret
is recovered by rotating, not by asking for it again.

### Test connection

A test is a **real notification of kind `test` through the real queue**. Never a second
inline send — that path could succeed while queue setup, sealing, payload lookup or worker
dispatch is broken, which is the precise failure a test exists to catch.

Because it is queued, it returns a **delivery id and a `queued` state**, and the page polls
an organization-scoped result until it settles or the page gives up waiting. The operator
sees the real outcome, just not synchronously.

Tests are **throttled per organization and per destination**, server-side. Without it an
owner session can generate unbounded outbound messages and provider cost.

### What a destination reads out as

Id, name, kind, enabled state, the alerts it is subscribed to, when it last succeeded, when
it last failed, and the sanitised reason for that failure. Never the sealed config.

The target needs to be **recognisable without being revealing**:
- A webhook shows its origin and an elided path. Two webhooks on the same host get a short
  non-reversible fingerprint so they can be told apart.
- A Telegram destination shows a **masked chat id suffix** and the thread id if there is
  one. Never the bot token. "Telegram" alone is not enough to confirm which chat was set up.

### Disabling

Disabling currently stops only *new* deliveries, because the subscription lookup filters on
enabled. That leaves already-queued deliveries to fire afterwards. Disabling therefore
**marks queued deliveries abandoned in the same transaction**, and the worker **re-checks
`enabled` after fetching the destination**. A request already in flight may still complete,
and the page says so rather than pretending otherwise.

## What this slice must also carry

- **Retention.** 90-day organization-scoped cleanup of notifications and deliveries, and a
  notification is never deleted while any of its deliveries is queued, retrying or held in
  the dead-letter queue. No cleanup exists today.
- **Dead letters.** Nothing consumes `notification.deadletter` and nothing surfaces it. An
  unexpected dead letter must become visible to an owner, be retryable or dismissable, and
  the corresponding delivery must not sit in `queued` forever.

## Shape

Contracts own the zod inputs and outputs. Repositories are organization-scoped and take an
`Executor`. The controller owns the transactions and writes audit for every mutation. The
router does capability checks and nothing else.

## What proves it works

- Colocated unit tests, including **cross-tenant** cases on every new repository method.
- The quiet cases above, each with its own test.
- Playwright against the running stack, ending in a **real webhook delivery whose signature
  verifies**: a receiver that recomputes the HMAC over `${id}.${timestamp}.${body}` and
  accepts it. A test that reports success while the signature does not verify is the exact
  failure this slice exists to prevent.
