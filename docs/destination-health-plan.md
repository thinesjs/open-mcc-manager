# Destination health ordering

## What I claimed earlier, and why it was wrong

The work queue recorded this as a live bug: `markDestinationOutcome` does an unguarded
last-write-wins update of `lastSucceededAt` / `lastFailedAt` / `lastFailureReason`, so two
deliveries to one destination settling out of order leave its health display stale or inverted —
and that it was "NOT gated by replica count".

The replica-count part is wrong. Read from source, three independent facts close every path to
the race as the system is deployed today:

1. `pg-boss` 12.30.0 `manager.js:546` destructures `batchSize = 1` and `localConcurrency = 1`.
   Neither is configured anywhere in this repo (`batchSize`, `localConcurrency`, `teamSize`,
   `teamConcurrency` have zero non-test matches), so one worker process fetches one delivery at a
   time per queue and runs one handler invocation at a time.
2. The drafted `worker.yaml` sets `replicas: 1`, and there is no `HorizontalPodAutoscaler`
   anywhere in the manifests.
3. A destination's deliveries never span the two concurrent queue workers, because kind is
   immutable: `destination.controller.ts:277` throws `DestinationKindImmutableError` on any edit
   that would change it, and `queueFor` routes purely on kind.

With one sequential worker, `deps.now()` is called at settle time, so writes land in
non-decreasing timestamp order by construction. Even the interleaving that looks dangerous —
delivery A fails, delivery B succeeds, A's retry fails later — writes fail(T1), success(T2),
fail(T3) with T1 < T2 < T3, which is chronologically correct.

**So this is not a live defect.** Filing it as one would have meant shipping a fix, and a test,
for a race that cannot currently occur.

## The finding that is actually real

The correctness of destination health silently depends on the worker staying at one replica, and
nothing in the repository records or enforces that.

Raising `replicas` to 2 is an ordinary operational action with no visible connection to this
invariant. The moment it happens, two workers can fetch two deliveries for one destination and
settle them in either order, and the destination's health summary can show a stale failure reason
next to a newer success, or an old success next to a newer failure. `settleDelivery` and
`markDestinationOutcome` share a transaction, so each settle is atomic — but atomicity is not
ordering, and nothing compares the incoming timestamp against what is already stored.

This is a latent scaling trap, not a bug to hotfix. It should be closed before anyone scales the
worker, not after.

## A second protection the fact list missed

The invariant is not only protected by "nobody raises `replicas`". It is equally broken by adding
`localConcurrency` or `teamConcurrency` to either `boss.work(...)` registration in
`apps/worker/src/bootstrap.ts` — a pure code change with no manifest edit and no operator
involvement, and arguably the likelier path, since a developer tuning delivery throughput reaches
for that before touching Kustomize.

There is a second, independent margin worth naming: `workDeliveries` processes its batch with a
sequential `for...of` and `await`, not `Promise.all`. So even raising `batchSize` alone, without
touching concurrency, still settles deliveries one at a time in fetch order.

## Options

**A. Guard the write by timestamp.** Update the health columns only when the incoming observation
is newer than the stored one. Local to the repository function; needs no new column, because
`lastSucceededAt` and `lastFailedAt` already exist as nullable timestamps to compare against.

**B. Record and enforce the single-replica constraint.** Document the invariant next to
`replicas: 1` and leave the code alone. Free, but protects nothing — and per the section above it
does not even name the concurrency path, which is the one a code change can trip.

**C. Do nothing, revisit if the worker is ever scaled.** Honest, given the race is unreachable.
Leaves a trap whose blast radius is operator trust in the health display.

**D. Stop denormalising: derive health from the deliveries table on read.** Architecturally the
most honest — a collapsed summary is exactly what lets commit order corrupt a value, and
per-delivery rows are each keyed by their own id, so there is no write race at all. Rejected on
read cost: `listDestinations` is today one flat `SELECT ... ORDER BY name`, independent of
delivery volume, and it loads on every visit to the destinations page. Deriving needs a
`DISTINCT ON` or lateral join per destination per state plus a new composite index, turning a
hot, cheap read into one that scales with delivery history. The write is comparatively rare. It
also does not settle the ordering-key question below — it inherits it unchanged.

## Recommendation

**A, anchored on the observation timestamp `settledAt`, plus the invariant recorded in the
manifest.**

### Why not a settle-time database clock

A guard keyed on a value the database computes inside the settle transaction — `now()`,
`clock_timestamp()`, `txid_current()` — is not a fix, it is a restatement of the bug. Any such
value is assigned in lock-acquisition order, which is commit order, which is precisely what
unguarded last-write-wins already uses. Guarding on it is mathematically indistinguishable from
not guarding. This must not be allowed to masquerade as the clock-skew fix.

### Why that argument does not transfer to the process clock

`settledAt` is taken at `delivery.job.ts:142`, *before* the transaction opens — after the network
attempt returns, and before any row lock is acquired. It is therefore not commit-ordered. Two
deliveries can carry `settledAt` values in the opposite order from their commit order, and that
divergence is exactly the window a guard closes. The critique above kills the database clock; it
does not reach the process clock.

### Why not anchor on `delivery.createdAt`

`createdAt` is skew-free — assigned by the one shared Postgres at creation — and that makes it
tempting. It is nonetheless the wrong key for these columns, on two grounds.

*Semantics.* `lastSucceededAt` / `lastFailedAt` / `lastFailureReason` mean "when this destination
last succeeded or failed". That is an observation, not a dispatch. `createdAt` is dispatch time.

*Magnitude.* `MAX_RETRY_SECONDS` is 3600, so a retried delivery's `createdAt` can precede its
observation by up to an hour. Anchoring on `createdAt` would let a delivery created five minutes
later but observed fifty-five minutes earlier win, deliberately displaying the older observation
and discarding the newer one. That trades a clock-skew error of milliseconds under NTP for a
designed-in staleness of up to an hour — three orders of magnitude the wrong way, on the field
whose entire purpose is to say how the destination is doing *now*.

Anchoring on `createdAt` also costs a migration and two new columns, and therefore a rebuild of
the migrate and worker images. The guard on `settledAt` costs none of that: it compares against
columns that already exist. The migration in the reviewed proposal is a cost of the anchor choice,
not a cost of guarding.

### The predicate, which is not per-column

"Only write when the incoming observation is newer than the stored one" is ambiguous, and the
obvious reading of it is wrong. A failure-write that compares only against `lastFailedAt` lets a
stale failure at T1 pass when `lastFailedAt` is null or older, even though a success at T2 is
already stored — so it writes a failure reason over a newer clean success, which is exactly the
corruption test 1 exists to catch.

The guard must compare against the newer of both anchors, identically in both write directions:

```
incoming > GREATEST(COALESCE("lastSucceededAt", '-infinity'), COALESCE("lastFailedAt", '-infinity'))
```

Two cases then need no special handling. A tie is rejected by the strict `>` alone, so the second
of two equal-timestamp writes loses and the first stands. And a first write against null columns
is admitted by the `COALESCE` to `-infinity`. Neither needs its own branch.

### Honest accounting

This is hardening, not a fix, and the commit message and changelog must say so. Claiming it
"fixes a race in destination health" would misstate severity.

The claim has to be scoped to what was actually checked. What has been established is that no
reachable interleaving exists *in the deployment topology this repository ships and controls* —
`docker/compose.yml` today and the drafted Kustomize manifests tomorrow, both at `replicas: 1`,
with no scale flag and no autoscaler anywhere. It does not extend further than that. This project
ships to self-hosters, and `infra-plan.md:203` treats an external self-hoster on Kubernetes as a
real audience rather than a hypothetical, so nobody here can see whether some third party already
runs the worker at two or more replicas through their own compose override or their own manifests.
"No production data is corrupt" would be a claim about deployments outside this repository's view,
and it is not one this work can back. Say the narrower thing, which is the true one.

The guard's honest value is narrow and worth stating: it closes the millisecond window where
settle order and commit order diverge, and it removes the dependency on deployment topology so
that raising replicas or handler concurrency later is no longer silently unsafe.

## What the tests must prove

Every test below must be shown to fail with the guard removed, or be explicitly labelled as
something else. That bar disqualifies three of the five originally listed here, which is recorded
rather than quietly fixed:

**Race-proof — these fail with the guard removed:**

1. A success at T2, then a stale failure at T1: the success survives and the reason stays null.
2. A failure at T2, then a stale success at T1: the failure and its reason survive.
3. A failure at T2 with reason A, then a stale failure at T1 with reason B: reason A survives.
   This same-outcome case was missing from the original list and is a real corruption scenario —
   an older failure reason overwriting a newer one — not a nice-to-have.
4. A tie at equal timestamps must leave the **first** write standing. Asserting that the second
   write wins would pass identically without the guard, since that is just last-write-wins; only
   asserting the first survives discriminates.

5. A success at T2, then a stale success at T1: `lastSucceededAt` stays T2. Symmetric to test 3
   and the same class of bug; success unconditionally nulls the reason regardless of timestamp, so
   only the timestamp can regress here. Lower stakes than 3, and the predicate above handles it
   without extra code, but it is not otherwise verified by name.

**Sanity, not race-proof — these pass with the guard removed and must not be counted as
evidence:**

6. In-order writes still apply, both directions. Worth keeping: it is the only test that catches
   an *inverted* comparison, which none of the above would.
7. A first write against null columns still applies, both directions. `IS NULL OR ...` and no
   guard behave identically when there is nothing to compare against.

## Why the `coalesce` cannot be tidied away

`GREATEST` in Postgres ignores a NULL argument and returns NULL only when *every* argument is
NULL. Verified directly against the running Postgres 17 rather than assumed:
`greatest(null::timestamp, '2026-01-01'::timestamp)` returns the date, while
`greatest(null::timestamp, null::timestamp) is null` is true and
`(greatest(null::timestamp, null::timestamp) < '2026-06-01'::timestamp) is null` is also true.

So on a destination with no history at all, `GREATEST("lastSucceededAt", "lastFailedAt")` is NULL,
the comparison evaluates to NULL rather than TRUE under three-valued logic, and `WHERE` rejects
the very first write. The `coalesce` to `-infinity` is what admits it. It looks redundant —
`GREATEST` appears to handle nulls sensibly, and it does, right up to the all-null case.

No comment marks this, because application code here carries none and the suite already does the
work: removing only the `coalesce` while keeping `GREATEST` fails **all seven** tests, since every
test begins with a freshly seeded destination and so its first write is rejected. A future
"isn't this redundant?" pass cannot get past the gates.

One residual, accepted: the raw `sql` fragment's column names are not typechecked, so a rename of
`lastSucceededAt` or `lastFailedAt` would not raise a compiler error here the way every other
reference in the file would. It would fail the whole describe block at the database level with
"column does not exist", so the suite closes it — but a green `tsc` is not evidence this fragment
tracks a rename.

## Separately: the dead-letter queue is inert

Found while verifying the above, unrelated to ordering and not fixed by this slice.
`delivery.job.ts:187` enqueues every permanently-failed delivery to `NOTIFICATION_DEADLETTER_QUEUE`,
and `apps/worker/src/bootstrap.ts` registers five `boss.work(...)` handlers — for host teardown,
status escalation, notification cleanup, and the two delivery queues — and none for the
dead-letter queue. Nothing ever drains it. The enqueue's failure is also fatal to the settle
transaction (`if (dead === null) throw`), so the write matters even though the read never happens.

This needs its own decision: either a handler, or a deliberate choice that the queue exists purely
as an audit trail drained by retention. It should not be discovered later as an unbounded table.
