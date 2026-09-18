# AGENTS.md

Build rules for open-mcc-manager. This file is the source of truth. Security
posture and the trust boundary live in `SECURITY.md`; read that too before
touching auth, secrets, or host access. Those two files are the whole
specification. `docs/superpowers/` is gitignored AI planning material that no
clone receives, so nothing here cites it and nothing may start to: a design
decision that matters belongs in this file or in `SECURITY.md`, where a
reader can actually find it.

## Stack

Hono + `@hono/trpc-server` for the HTTP layer, tRPC v11 for the API, Kysely
over `pg` for the database (Postgres 17), better-auth with the organization
plugin for auth, `libsodium` sealed boxes for secret storage, `ssh2` for host
transport. The dashboard (`apps/web`) is Vite + TanStack Router + TanStack
Query + the tRPC client, styled with Tailwind v4 and shadcn (`base-mira`
style, zinc base, `cssVariables: true`, lucide icons, `~/` alias — see
`apps/web/components.json` and `apps/web/src/index.css`). pnpm workspaces,
orchestrated by turbo.


### is-active is not health

systemd reporting a unit `active` means the process exists. It does not mean the
client is connected to anything. The client can be wedged — an unparseable
config, a server it cannot reach, an interactive prompt it is waiting on — and
sit there indefinitely without exiting, because `ExitOnFailure` lives in the file
that failed to parse and because the control FIFO never reaches end-of-file.

Before this was handled, every signal agreed the instance was fine: `is-active`
said `active`, the reconciler compared desired `running` against observed
`active` and found no drift, the unit file was byte-correct so there was no unit
drift, and the dashboard said "Connected and supervised by systemd". Worse, a
scheduled command still reported success: systemd holds the FIFO open, so a write
lands in the pipe buffer and returns 0 whether or not anything reads it. Verified
directly — two writes to a FIFO whose holder never reads both exit 0.

Reconciliation therefore reads the journal for any instance systemd calls
`active` while the database says `running`, and reports `stuck` when it finds a
line the wedged client prints. The markers in `STUCK_MARKERS` were observed from
build 511, not guessed. If you add a supervision feature, assume a live process
proves nothing and find a signal that distinguishes working from present.

### Where the status observer resumes from

The position `packages/core/src/status/instance-observer.ts` stores between polls
is **journald's own cursor**, taken from `--show-cursor` and spent as
`--cursor`, never a clock reading. A timestamp window worked, but it was a
wall-clock value compared against lines stamped by the same wall clock: a
backwards **clock step** — an NTP correction large enough to step rather than
slew, or a VM resuming with a stale clock — left the stored value in the future
relative to new lines, and the window matched nothing until real time caught up.
A cursor is an opaque sequence identifier and is immune to that. Say clock step,
not snapshot restore: a snapshot restore rolls the journal back **with** the
clock, and that case is not proven here.

The command that was replaced hid a second fault worth knowing about, because it
is the shape to avoid rather than repeat: `{ journalctl … || true; } | head -n
2001` turned a genuine refusal — exit 1, empty stdout, `Failed to seek to cursor`
on stderr — into exit 0 with empty stdout, which the observer read as "no new
lines". A read whose failure is indistinguishable from silence stalls for good
and reports nothing. That is why the bound is now journalctl's own `-n` and there
is no pipe: the exit status is the reader's again.

- The resume is `--cursor`, which is **inclusive**, and the batch is bounded by
  journalctl's own `-n`, which counts **forward** from the cursor. So the cursor
  `--show-cursor` reports always names the last line of the batch, which is the
  line the next read starts at. A full batch withholds that line as lookahead
  rather than judging it, so no disconnect is ever judged without the line that
  may carry its reason; a short batch judges it and re-reads it once next poll,
  which yields the same signals and so no change.
- **A vacuumed cursor still resumes.** `scripts/sandbox/journal-cursor.sandbox.ts`
  deletes the journal file holding the cursor's own entry on Debian 12, Debian 13
  and Ubuntu 24.04 and reads again: journalctl exits 0 and returns everything
  logged since. Vacuuming is not a hazard, and nothing fabricates a fallback for
  it.
- **A position the host cannot seek to is not silence.** journalctl exits
  non-zero with `Failed to seek to cursor`, identically on all three images.
  `journalRefusedCursor` recognises exactly that, the drain reads the journal
  afresh in the same cycle, and the server logs it. Treating it as "no new lines"
  would be indistinguishable from the stall this design removes.
- **A stored value that is not a cursor is never spent as one.** `isJournalCursor`
  refuses it in the manager, before any host sees it, and the read takes the seed
  path. That is how the timestamps stored before this change migrate: one seed
  read each, reporting only the latest signal, so no history is replayed as fresh
  alerts. Its pattern is **anchored at both ends, and that is load-bearing**: the
  cursor is interpolated into a command a shell evaluates, `JSON.stringify`
  escapes `"` and `\` but not `$` or a backquote, and the value's source is text
  the host sent. Unanchoring it is a shell injection, and
  `packages/contracts/src/boundary/journal.test.ts` refuses a cursor carrying
  `$(id)`, a backquoted command, a trailing newline and a second line, in front
  and behind.
- **A usable position with nothing new returns exactly one line — its own.**
  `--cursor` is inclusive, so a resumed read can only come back empty if the
  entry it names is gone. Zero lines is therefore a signal, not a silence, which
  is what makes the residual below legible rather than mysterious.

**Residual, accepted, and not to be "fixed".** A position whose sequence number is
ahead of anything in the journal comes back exit 0, `-- No entries --`, no lines
and **no cursor note** — on Debian 12 it comes back exit 1 with an empty stderr
instead, which is the one place the three images disagree and it changes nothing,
because the refusal is recognised from journalctl's message and not from its exit
status. The observer keeps the stored position and reports nothing, so that state
would look like a quiet bot. It is left that way deliberately:

- The realistic route to zero lines is not a position ahead of the journal — it is
  **a quiet bot whose cursor entry was vacuumed on a busy host**, and that bot
  resumes correctly from the very same position as soon as it logs again.
- Treating zero lines as a refusal would force a seed read every poll for every
  quiet bot, and the seed branch records its latest signal unconditionally.

So `batch.cursor ?? cursor` — keep the position when the host named none — is the
correct call, and turning it into a re-seed is a regression, not an improvement.

### Why the scheduler needs no actor context

`runScheduledCommand` takes an `InstanceCommandRow` and no `ActorContext`. It
derives its scope from `row.organizationId` alone. That is safe because of a
database constraint, not because of the code: `instanceCommand` and
`instanceSchedule` both carry a composite foreign key
`(organizationId, instanceId) → instance(organizationId, id)`, so a row's
organization and instance are guaranteed to belong together. A row cannot point
at another organization's instance even if something managed to write one.

Do not drop those constraints to "simplify" the schema. Without them the
scheduler would need a real actor to scope against, and the alternative —
fabricating a synthetic owner context — puts a privileged identity in a
background loop.

### Exit codes, as observed rather than assumed

Verified against build 511 with a FIFO on stdin, the way the unit runs it:

- `3` — the server could not be reached, or dropped the connection. Restartable.
- `4` — sign-in did not complete. `RestartPreventExitStatus=4` stops the unit here.
- `0` — clean exit.

`2` (an in-game kick) is **not** verified: reproducing it needs a real server that
kicks a joined player. The mapping is safe either way, because an unrecognised
code is treated as restartable, which is what a kick would want.

The `4` case is broader than its name suggested. It is not only a rejected
credential — a *network* fault while contacting the auth service exits `4` too,
and the unit then stays down until an operator acts. That is the deliberate
trade: never hammer Microsoft auth on a bad token, at the cost of a transient
network fault during sign-in needing a manual start. The dashboard says so
rather than claiming the login was rejected.

### The two client settings the supervisor depends on

`renderInstanceConfig` writes `Main.Advanced.ExitOnFailure = true` and
`Main.Advanced.EnableSentry = false` as fixed literals, not operator choices.

`ExitOnFailure` is load-bearing for the whole supervision design. Left at its
default of `false`, the client does not exit when it cannot reach a server — it
prints a prompt and waits on stdin. Under the unit that stdin is the control
FIFO, which never reaches end-of-file, so the process sits there forever. systemd
reports the unit `active`, `Restart=on-failure` never fires, and reconciliation
compares a desired `running` against an observed `active` and reports no drift,
while the instance does nothing at all. Verified against build 511: with
`ExitOnFailure = true` and a FIFO on stdin, an unreachable server exits `3`, which
is the code `RestartPreventExitStatus=4` and the exit-code policy are written
against.

`EnableSentry` defaults to `true` and sends client errors to a third party. A
self-hosted deployment should not phone home, and the key is not in
`ALLOWED_CONFIG_KEYS`, so an operator could not have turned it off.

### The pinned player-name check, and what depends on it

`renderInstanceConfig` writes `Main.Advanced.IgnoreInvalidPlayerName = true` as a
fixed literal, and the key is in `FIXED_CONFIG_KEYS`, so a host that turns it off
reports safety drift.

Pinning it changes no behaviour today, because `true` is already the client's own
default. It is pinned because otherwise a bound this manager relies on would rest
on a default this project does not own. With the check on, the client drops a
joining player whose name is not a real Minecraft name — the decorated
placeholders some servers put in their tab list. With it off, those names reach
the client's player list and then any readout built on it.

That makes the pin load-bearing for the player-name shape a reader on this side
may assume: unpin it and a strict parser rejects **the entire players readout**
rather than the one bad entry. The manager pins and rejects rather than silently
filtering such an entry, because filtering here would hide either fixed-config
drift or an upstream change to what the client promises. Do not relax the pin to
make a player-name test pass, and do not add filtering in its place.

## Prohibitions

- No Next.js, in any form, ever.
- No code comments in application code. Names and types carry the meaning.
- No commit descriptions. Subject lines only, imperative mood, Conventional
  Commits (`type: subject`; the scope in `type(scope): subject` is optional and
  this branch's history does not use it).
- No `any`, no non-null `!`, no definite-assignment `!` on a declaration, no
  `@ts-ignore`, no `@ts-expect-error`, no `@ts-nocheck`, no type assertions
  except `as const`.

## Type policy

- `never` appears only in `packages/core/src/lib/exhaustive.ts`
  (`assertExhaustive`).
- `unknown` appears only under `packages/contracts/src/boundary/`.
- Types are always derived, never hand-written: `z.infer` for contracts,
  `Selectable<T>` / `Insertable<T>` (Kysely) over the generated database
  types for rows.
- Model state as discriminated unions and switch exhaustively with
  `assertExhaustive`.

## What enforces what

Each rule above is either checked by a named tool or rests on review alone.
This table says which. Do not describe a rule as enforced without adding it
here and adding the test that proves it.

| Rule | Enforced by |
| --- | --- |
| No Next.js | `check-type-policy.mjs` — `next` and `next/*` module specifiers, `next` and `@next/*` manifest dependencies |
| No code comments | `check-type-policy.mjs` — any comment trivia in a scanned file |
| No commit descriptions, Conventional Commits subject | `check-commit-subjects.mjs`, in CI, on pull requests only |
| Imperative mood in subjects | nothing — review only |
| A client version bump is recorded as audited | `mcc-compat.test.ts` — the newest entry in `docs/mcc-compat.md` names `MCC_VERSION` and carries a finding on all six surfaces, and the captured fixture names the same build. It proves a record exists, NOT that the audit happened |
| No `any` | Biome `suspicious/noExplicitAny` |
| No non-null `!` | Biome `style/noNonNullAssertion` |
| No definite-assignment `!` | `check-type-policy.mjs` |
| No `@ts-ignore` | `check-type-policy.mjs`; Biome `suspicious/noTsIgnore` catches only the own-line `//` form |
| No `@ts-expect-error` | `check-type-policy.mjs` alone — Biome never flags it in any form, because switching to it is `noTsIgnore`'s own suggested fix |
| No `@ts-nocheck` | `check-type-policy.mjs` |
| No type assertions except `as const` | `check-type-policy.mjs` |
| The checker skipping `.claude` only at the repository root | `check-type-policy.test.ts` — a nested `apps/web/.claude` must be scanned and a root `.claude/worktrees/...` skipped, so returning it to a single any-depth skip list fails. `biome.json`'s matching half rests on review |
| `never` outside `exhaustive.ts` | `check-type-policy.mjs` |
| `unknown` outside `boundary/` | `check-type-policy.mjs` |
| Derived types, never hand-written | nothing — review only |
| Discriminated unions with `assertExhaustive` | nothing — review only; the helper itself is covered by `packages/core/src/lib/exhaustive.test.ts` |

Forty-four rules stated further down this document are enforced too, and are
listed here for the same reason — so that nothing claims enforcement it does not
have:

| Rule | Enforced by |
| --- | --- |
| Organization scope on every repository method but the exceptions named under Tenancy | TypeScript — the scope is a required parameter, so a call without one does not compile |
| Operator-facing copy for every wire error code | TypeScript — `apps/web/src/lib/errors.ts` types its table `Record<ErrorCode, string>` over `packages/contracts/src/errors.ts` |
| The sign-in hold's refusal naming its own duration, and carrying the way out of it | `apps/web/src/lib/errors.test.ts` — the sentence is compared whole and its minute count against `AUTH_LEASE_MS`, and it is required not to say a sign-in is running, which only `INSTANCE_SIGN_IN_RUNNING` may say; `apps/web/src/components/instance-action-error.test.tsx` — walks **every** `ErrorCode` and requires the Cancel sign-in button, and the "Ask an owner" line, on `INSTANCE_AUTH_IN_PROGRESS` and on no other, so widening the condition to a second code fails rather than passing on the one code a sample happens to take; the same file walks every `Role` and requires the button for `owner` alone |
| Both ways a sign-in can fail carrying a sentence, and not the same one | TypeScript — `apps/web/src/lib/errors.ts` types its table `Record<ErrorCode, string>`, so a new code without copy does not compile; `apps/server/src/errors.test.ts` walks every error class the domain packages **export** and requires a mapping, which catches a new exported class and **not** a bare `Error` thrown inline — that is held instead by `authenticate.test.ts`'s `expect(silent.constructor).not.toBe(Error)`, which a subclass passes and a bare one does not; `apps/web/src/lib/errors.test.ts` compares both sentences whole and requires the one for a start that ran not to say "did not start" nor to promise a wait |
| An SSH exec that resolved non-zero answered 400, not 409 | `apps/server/src/errors.test.ts` — requires `INSTANCE_SIGN_IN_DID_NOT_START`, `INSTANCE_SIGN_IN_NO_DEVICE_CODE` and `INSTANCE_REMOVAL_FAILED` to be `BAD_REQUEST` and a transport timeout and a live sign-in to stay `CONFLICT`, in one test, so moving either side of the line fails it. It pins those five and claims nothing about the rest of `mapKnownError`. No symptom holds it: the only reader of `httpStatus` outside tests in `apps/web` is `wasRefused`, which takes the whole 4xx band |
| A sign-in that never started reported as one, rather than as a client that said nothing | `packages/core/src/instance/authenticate.test.ts` — runs `beginAuthentication` twice over the **same empty log**, the start exiting 0 in one and 1 in the other, and requires the two to fail differently, so an implementation that reads the log rather than the exit gives one answer twice and fails it; requires the refused run to issue **no** `cat` poll where the quiet run issues all of them, so moving the check past the loop keeps the class right and fails on the wait; and, with a device code left in an uncleared log, requires the refusal rather than the stale code. `apps/server/src/errors.test.ts` compares the mapped answer whole and requires it to carry no word the host wrote; `apps/web/src/lib/errors.test.ts` compares the operator's sentence whole and requires it to differ from the running and the holding ones |
| The refusal reaching an operator on every surface that can raise it | TypeScript — `onActionError` is a required prop of `CommandPaletteProps` and `InstanceContextMenuProps`, so a surface that fires start, stop or restart without wiring the refusal does not compile; `apps/web/src/routes/_authenticated.instances.index.test.tsx` and `apps/web/src/components/command-palette.test.tsx` drive a refused start through the context menu and through the palette and read the guidance text off the rendered alert |
| Design tokens pinned against drift | `apps/web/src/index.css.test.ts` — every declaration compared by scope, name and value |
| The documented `.env` setup path | `scripts/load-env.test.ts` |
| The host status union matching between `packages/db` and `packages/contracts` | TypeScript in one direction only — `host.controller.ts`'s `toHostPublic` rejects a database union wider than the contract's. A contract union wider than the database's compiles and passes every test, so that direction rests on review |
| Every domain error class but one carrying a wire error code | `apps/server/src/errors.test.ts` — the classes are read off what `@open-mcc/core` and `apps/server/src/errors.ts` export, so a new one with no case in `mapKnownError` fails. `InternalError` is the single excused class, and the excusing is an exact-identity list of one that the same file asserts, beside a case requiring `mapKnownError` to answer it `null`: it means 500, so a mapping would be the lie. A class that is declared and never exported is not seen: `InstanceNotRunningError` was one, unmapped on the console-command path, until it was exported |
| A start, restart, stop, console command or console read the host refuses answering in that verb's words, never as an internal error | `apps/server/src/instance.test.ts` — drives all five over HTTP against a scripted host and compares the whole wire answer. Start is refused three ways — at its unit, by a unit that went down, and at the environment write before the unit is asked — each a different site the fix did not touch, so they pass because `failingAs` wraps the verb's host work rather than because a site names the verb. Those three sites threw a bare `Error` until the row on `packages/core/src` below; they now throw `HostRefusedError`, which the boundary converts in exactly the same way, so what these cases measure is unchanged. The two answers a start cannot read are no longer refusals; they are held by the row below. A restart whose stop is refused must read as a stop and issue no start. A stop whose transport throws something that is not an `Error` must stay a 500, so a discriminator that converts a non-`Error` fails it. `apps/web/src/lib/errors.test.ts` compares the five sentences whole and requires them distinct. What it does NOT hold: that a sixth verb has a boundary; that a bare throw added before a verb connects is covered; that an `Error` subclass with no mapping is covered — `failingAs` passes every subclass through, so one still reads as an internal error unless the row above sees it. **Nor does it hold the pass-through of typed errors in general.** Two classes are pinned: `InstanceSignInRunningError`, by the start case that must still read as a running sign-in, and `HostAnswerUnreadableError`, by the two start cases in the row below. The discriminator that rethrows just those seven classes — `InstanceSignInRunningError`, `InstanceStopFailedError`, `ChannelLimitReachedError`, `HostUnreachableError`, `InstanceBusyError`, `DoubleSlashCredentialError` and `InstanceHostNotProvisionedError` — and converts everything else no longer passes, because it converts `HostAnswerUnreadableError`; adding that eighth class to its list makes it pass the whole suite again while still turning a `TypeError`, `CommandTimedOutError`, `CommandAbortedError`, `StreamOverflowError`, `ReadDeadlineExceededError` and `DisallowedInternalCommandError` into a verb failure — measured, not argued. A plain `Error` raised by the SSH transport itself, and the settings write inside a start, are inside the boundary by construction and are not driven. A **manager-side** plain `Error` inside a boundary is blamed on the host and nothing catches it: send wraps `loadHost`'s database reads and `secrets.open`, a console read wraps `leaseHostReader`'s database reads, a start wraps `writeTokenUnderClaim`, and pg's "Connection terminated unexpectedly" is a plain `Error` — so a database blip during a console poll reads as the host not sharing the bot's output |
| An answer the host gave that the manager could not read saying so, rather than as a refusal or as an internal error | `apps/server/src/instance.test.ts` — drives a start whose unit answer the manager cannot parse, a start whose environment answer it cannot parse, and a **Check sign-in** whose probe answered unreadably, over HTTP against a scripted host, and compares each whole wire answer against one sentence; the environment case also requires no start to be issued, and a fourth case drives a refused start and an unreadable start over the **same verb** and requires the two answers the server actually produced to differ in code, message and status, so collapsing the classes fails there even if both constants moved together. The probe case scripts `SESSION_CACHE_UNREADABLE_EXIT`, but `authenticate.ts` routes **every** unmodelled exit through one branch, so nothing holds that exit 2 is told apart from a 127 — the constant in that test documents intent, it does not discriminate. `packages/core/src/instance/instance.controller.test.ts` requires a reconcile whose facts came back garbled to read `unreadable` and, next to it, a reconcile whose transport threw to read `interrupted`, so mapping both to one reason fails. `apps/web/src/lib/errors.test.ts` compares the operator's sentence whole, requires it to promise no wait, and requires no other `ErrorCode` to carry it; `apps/web/src/lib/drift.test.ts` walks every `HostUnreachableReason`, requires distinct words, and requires no reason's word set to be a subset of another's, so a sentence that only restates a neighbour in fewer words fails rather than passing on being a different string — which is what `failed`'s "OpenMCC could not read it." was doing beside `unreadable`; it now says the check could not be started, which is what a lease that never opened means. Because the class is an `Error` subclass, the two start cases pin it through `failingAs` as well. What it does NOT hold: that a **new** unreadable answer throws this class rather than a bare `Error` — nothing enumerates the parse sites, and the four in this class were found by reading, a search for `=== undefined` beside a throw that cannot see the sign-in probe, which is an unmodelled **exit code** and not a parse at all. Nor that reconcile's other branch — a facts command the host refused — says anything true: it still reads `interrupted`, so an operator is told the host stopped answering when it did not. Nor a real truncated read: every site is driven through a fake transport |
| Work the manager could not queue or record saying so, and saying nothing was sent, rather than reading as an internal error | `apps/server/src/error-serialization.test.ts` — drives **Send test alert** and **Retry** over HTTP against a real database, with the job queue answering under the test's control, and compares each whole wire answer against one sentence. Both ways the work can fail to be accepted are driven under that one sentence: the queue reporting it inserted nothing, and the queue call throwing a plain `Error` of its own, which is what pg-boss raises for a queue that is not there. Two further cases hold the sentence's second clause: a failed test must leave **no** delivery row and **no** audit row, and a failed retry must leave the delivery under the same id, still `failed` and unaudited — so dropping the transaction around either, or committing the requeue before the work is accepted, fails there; that case checks the delivery's id and state and says nothing about `attempts` or `lastError`. A fifth case requires a test the queue did accept to still leave a queued delivery and its audit row, so the refusal is not blanket. Two more hold the discriminator, which nothing held before they were added: a queue that throws a `TypeError` and a queue that rejects with a value that is not an `Error` must each stay a 500 carrying neither the code nor the sentence, so replacing the guard with `throw new AlertNotQueuedError(String(error))` — which passes every other test in core and server — fails there. Because a `TypeError` is a subclass, that case pins the subclass half generally, so a pg `DatabaseError` still reaches the constraint mapping, though no test drives one. `apps/web/src/lib/errors.test.ts` compares the operator's sentence whole, requires it to promise no wait, to name no queue, job, database, table or row, and requires no other `ErrorCode` to carry it. What it does NOT hold: the two row-came-back-empty guards inside the test path. `createNotification` and `createDelivery` answer empty only when their `ON CONFLICT DO NOTHING` fires, on a dedupe key and a notification id minted by `nanoid` in the same call, so neither is reachable without a collision and neither is driven — both are typed by hand. Nor that a **new** site that cannot queue or record throws this class rather than a bare `Error`: nothing enumerates them, and the search that found these — a literal `throw new Error(` across `packages/core/src`, `packages/transport/src`, `apps/server/src`, `apps/worker/src` and `packages/contracts/src`, 92 at `f9cb378` and 96 before that change, and 17 once the row below emptied `packages/core/src` of them — cannot see `reject(new Error(...))` inside a Promise executor, an `Error` built in one place and thrown in another, or a factory such as removal's `unfinished()`. Nor the same failure where **no operator is waiting**: `status.controller.ts`'s check that could not be scheduled and `announce.ts`'s delivery that could not be queued are raised only by the health poller, never by a tRPC procedure, and are deliberately left bare. The sentence promises no retry, and that is a deliberate trade rather than a fact about every member: pg's "Connection terminated unexpectedly" is a plain `Error`, so a transient database blip does become this class and waiting would genuinely help, but the reachable cause is a queue row that is not in the database, where "Try again" would be a false promise to most operators who see it |
| The provisioning claim conditioned on the status read before the lock | `packages/core/src/host/host.controller.transaction.test.ts` — substituting the row read under the lock makes the claim always succeed, and fails the test named for it |
| Every `var()` resolving to a declared or Tailwind-provided property | `apps/web/src/index.css.test.ts` — `TAILWIND_PROVIDED` is an explicit list of the names Tailwind supplies, never a `--color-*` prefix |
| The opaque fallback on the glass surfaces staying `!important` and negatively guarded | `apps/web/src/index.css.glass.test.ts` — the inverted form moves the blur inside a positive `@supports` and drops the `@supports not` block, so rewriting it that way fails |
| Only reviewed read builders turning text into a command a shared connection runs | `packages/core/src/instance/read-command-allowlist.test.ts` — every source file naming `asReadCommand` is compared against an exact list, so a new caller fails. It proves who can mint a read command, NOT that the command only reads: `asReadCommand` accepts any string, so a write minted inside an allowlisted file passes, and `HostReader.forward` is not covered at all |
| The provisioning lease covering the worst-case remote work | `packages/core/src/host/host.controller.test.ts` — the budget is computed from the steps `provisionHost` actually runs, so adding one fails the test |
| The client download's retries and backoffs ending inside the wait that step is given | `packages/core/src/host/provision.test.ts` — reads the deadline, the attempt bound, the first backoff and its growth off the command `provisionHost` actually issues, and requires `deadline + first × growth^(attempts − 2)` below that exec's wait, so raising either constant past the other fails it and a command with no retry at all fails it for want of the numbers. It proves the arithmetic, NOT that curl honours it: `packages/core/src/host/client-download.test.ts` runs the rendered command under `/bin/sh` against a stand-in origin for that, and `provision.sandbox.ts` runs it against the real one |
| Which download failures are worth retrying | `packages/core/src/host/client-download.test.ts` — drives the rendered command against an origin that answers 500, 503, a reset connection and a cut-short body, and one that answers 404 and 403, so widening the classification to everything fails the permanent cases and narrowing it fails the transient ones. It covers the codes the tests name, NOT every code in the two lists |
| Registration closed to every authentication method once a user exists | `apps/server/src/registration-gate.test.ts` — the gate is driven with a `create-user` source for each method better-auth can report as well as over HTTP, so unwiring it from `createAuth` or making it always admit both fail it |
| No sandbox container is given a host path, home directory, `~/.ssh` or the Docker socket | `scripts/sandbox/sandbox.test.ts` — every `docker` call the sandbox suite makes goes through one guard, which refuses, among the arguments of a `run` or `create` up to a `--` (a bind mount can only come from a docker-level flag before the image, never from the command run inside a container; every harness `run` builder passes `--` right before its image, and a call without `--` is scanned to its end, so a `v`-flag after the image is refused there too), any argument that is a short-flag group containing `v`, `--volume`, `--mount` or `--volumes-from`; refuses any argument naming `docker.sock` anywhere; and refuses every `docker cp` or `docker container cp` in either direction. So an in-container `grep -v` or `tar -xvf` under `docker exec` is allowed, while `run -dv /host:/c img` is not. Files reach a container on `docker exec` stdin. A direct `spawn("docker", ...)` would go around it |
| No sandbox container is killed or force-removed | `scripts/sandbox/sandbox.test.ts` — the same guard refuses `kill` and `restart`, an `rm` or `remove` carrying `--force`, `--force=…` or a short-flag group containing `f`, and any `stop` that is not `stop --timeout -1` or that carries `--signal` or `-s`, each with or without the `container` prefix, and the harness's own stop arguments are checked against it. A direct `spawn("docker", ...)` would go around it |
| A host-side deadline on removal's and teardown's deletes, ending inside the manager's wait | `packages/core/src/instance/removal.test.ts` and `packages/core/src/host/teardown.test.ts` — each reads `timeout -k <k> <n>` off the commands a removal renders or a real `tearDownHost` issues, and requires `n + k` below that exec's wait; `packages/core/src/host/deadline.test.ts` pins the wrapper's shape. It proves the arithmetic, NOT that a host kills anything: `removal.sandbox.ts` and `collector.sandbox.ts` prove that, outside `pnpm test` |
| The teardown queue retrying only after its longest host deadline | `packages/core/src/job/queue-setup.test.ts` — reads `retryLimit` 2 and `retryDelay` 60 off the reconciled queue and takes the longest deadline from the commands a real `tearDownHost` issues, so a deadline longer than the delay fails it |
| A new bot claimed by the statement that makes it visible | `packages/core/src/instance/instance.repository.test.ts` — on a real database the row `insert` returns already carries the claim id it was given and a `configClaimedAt` between two readings of the database's own `clock_timestamp()`, and every one of `claimForConfig`, `claimForLifecycle` and `claimForAuth` is refused against it, so inserting the row unclaimed fails it. That the claim is one statement and not two is held by the **type**, not by this test: `insert` requires a claim id and `InstanceCreateValues` omits both claim columns, so no caller can open the window, and a two-statement rewrite inside the repository leaves every test green |
| A config claim taken before the version it guards is read | `packages/core/src/instance/instance.repository.test.ts` — on a real database a finalize is held open on the row while `takeConfigClaim` runs against it, so comparing before claiming reads the version that finalize is replacing and fails the test |
| No repository call on the pool while a transaction is open, for either save, a removal, a start, a restart, a stop and a creation | `packages/core/src/instance/instance.controller.test.ts` — `withTransaction` hands in separate repositories, and every `deps.instances.*` call plus `deps.hosts.findById` and `deps.sshKeys.findById` records whether one is open, so moving a config read, `loadHost`, or a removal's own claim onto the pool repository inside the claim transaction fails it |
| No connect, exec or port probe while a transaction is open, for either save, a removal, a start, a restart, a stop and a creation | `packages/core/src/instance/instance.controller.test.ts` — the transport is wrapped and every sighting records whether a transaction is open, so running the config write inside the finalize, or a removal's connect inside its claim transaction, fails it |
| Every claimed window fitting inside the config lease | `packages/core/src/instance/instance.controller.test.ts` — sums the connect wait and every exec wait issued while the claim is held — up to the finalize for a save, a start, a restart, a stop and a creation, up to `deleteUnderClaim` for a removal — and compares the total against `CONFIG_CLAIM_LEASE_MS`, so splitting a step into two execs, connecting before the claim, or giving a restart's stop the ordinary step wait, fails it |
| Every pattern the browser masks being applied by the log redactor too | `packages/core/src/security/redact.test.ts` — `REDACTION_PATTERNS` is compared against `UNAMBIGUOUS_SECRET_PATTERNS` by identity and by length, so a pattern registered in `contracts` and left out of `redact`'s list fails it. It proves the server applies every shared pattern, NOT that a pattern belongs on the shared side: that judgement is review's |
| The console history keys swept on load and cleared by every sign-out | `apps/web/src/lib/command-history.test.tsx`, `apps/web/src/routes/_authenticated.sign-out.test.tsx` and `apps/web/src/components/sign-out.test.tsx` — all three drive the real `localStorage` jsdom provides rather than a stubbed map, seed more than one bot's key, and each also requires the theme and the real view-mode key to survive, so widening any of them to "remove everything" fails. The last two mount the shell, the palette and the invitation notice and click their real buttons, so unwiring `clearCommandHistories` from any of the three fails; a fourth `authClient.signOut` call site fails the exact-list assertion. That the clear runs *before* the sign-out is held in **all three** by a sign-out mock that never settles, so moving the clear after the call fails whichever path it is moved in. It proves each named path clears, NOT that a file with two sign-outs clears on both, and the exact-list assertion is textual — a fourth file destructuring `signOut` off `authClient` would evade it, as `read-command-allowlist.test.ts` can be evaded the same way |
| No lookbehind in a pattern the browser parses | `packages/contracts/src/command-credentials.test.ts` — the whole of `command-credentials.ts` is read and checked for `(?<=` and `(?<!`, so `COMMAND_PATTERNS` and any list added later are covered as well as `UNAMBIGUOUS_SECRET_PATTERNS`, whose compiled sources are checked too. esbuild lowers a lookbehind to a `new RegExp` call that throws on Safari before 16.4, and the browser evaluates the whole module, not the one list it imports from. It checks text and compiled sources, NOT that the bundle loads in any browser; it covers that one module, which is the only one `apps/web` shares with the redactor |
| The start step's wait covering what a start can legitimately take | `packages/core/src/host/unit-template.test.ts` — requires the `flock -w` plus `TimeoutStartSec` the unit declares to stay **below** its `JobTimeoutSec`, so raising either past that order fails it; `packages/core/src/instance/instance.controller.test.ts` — reads `JobTimeoutSec` off the rendered unit and requires the wait a start and a restart give `startUnitCommand` to be at least that plus `INSTANCE_STEP_TIMEOUT_MS`, so shaving the margin to a bare `JobTimeoutSec + 1` fails it. Those two hold the **ceiling** on `TimeoutStartSec` and nothing else; the **floor** is held only by `runtime.sandbox.ts`, which holds `collect.lock` past `INSTANCE_STEP_TIMEOUT_MS` and requires the start to survive it, so shaving `TimeoutStartSec` to 10 fails there while `pnpm test` stays green. The same file reads `TimeoutStartUSec` and `JobTimeoutUSec` back off a real unit, and holds a lock past the start phase to require `Result=timeout` — read off `Result`, never off `ActiveState`, because `Restart=on-failure` leaves a just-failed unit reporting `activating`/`auto-restart` |
| The sign-in step's wait covering what a sign-in's start can legitimately take | `packages/core/src/host/unit-template.test.ts` — requires the sign-in unit's `flock -w` plus its `TimeoutStartSec` to stay **below** its `JobTimeoutSec`, and that `TimeoutStartSec` to stay **above** the longest the collector may hold `collect.lock`, so both reordering the three and shaving the phase under its one bounded lock holder fail it; `packages/core/src/instance/authenticate.test.ts` — reads `JobTimeoutSec` off the rendered sign-in unit and requires the wait `startAuthCommand` is given to be at least that plus `AUTH_SESSION_TIMEOUT_MS`, requires **exactly one** wait in a whole `beginAuthentication` to exceed a stop's, so buying that margin by raising the shared session wait fails it, and sums every wait the sign-in claim covers against `AUTH_LEASE_MS`. Those hold the order and the ceiling; that a start bounded this way **survives** a held lock is held only by `scripts/sandbox/sign-in.sandbox.ts`, which holds `collect.lock` past the collector's own deadline and requires the sign-in to reach `active` with its container running. The same file reads all three bounds back off a real unit, and holds a lock past the start phase to require `Result=timeout` and the manager to give the claim back — read off `Result`, never off `ActiveState` |
| A start refused rather than run over a cache the host could not empty | `packages/core/src/host/unit-template.test.ts` — takes the cache step's own shell out of the rendered unit and runs it under `/bin/sh` against a scratch home: with a leaked cache, with none, against an `rm` shim that deletes one entry and fails, and against one that deletes the whole cache and fails. The third requires a non-zero status **and** the entries still there, so `rm -rf … \|\| true` with a `mkdir -p` passes the first two and fails it; the fourth requires a non-zero status **and** no remade directory, so a `;` in place of the `&&` — whose refusal would come from `mkdir` meeting a surviving directory rather than from the delete — fails there. The same block requires the delete to name **exactly one** path and that path to be the cache, so an extra operand, a dropped `--` or a repoint at `replays` fails; the shim reads the path from the test's own environment and refuses anything outside the scratch home, so no edit to the unit can point it at the machine running the suite. It proves the step refuses and leaves the evidence, NOT how long a delete takes: that is measured, not tested |
| A running bot keeping the token it started on | `packages/core/src/instance/unit.test.ts` — runs the env command under `/bin/sh` against a `systemctl` shim, once per state in `RUNNING_UNIT_STATES`, and requires `kept` on stdout with `env` and `unit.env` byte-identical, so narrowing the case list to `active` fails it; `instance.controller.test.ts` requires no `writeTokenUnderClaim` on a `kept` answer |
| One rule turning an account name into a shell word | `packages/contracts/src/host-account.test.ts` — runs the rendered command under `/bin/sh` against a `sudo` shell function and requires `loginctl`, `enable-linger` and the account to arrive as exactly three words, for an account carrying a space, a quote, a substitution, a second command, a glob, a trailing backslash, a leading `.` or `-`, and a newline leading, trailing or embedded. The shim delimits with `\0`, not `\n`, because a newline-delimited one cannot tell a newline in an account from a word break, and a newline account is representable — `selfHostOffer.username` has no character class. Broken escaping fails it rather than being pinned as a string. A second test requires a plain account to render **unquoted**, so quoting every account — which leaves every one of those cases green and changes the command every operator sees — fails there. The same file lifts the `case` block out of `scripts/self-host.sh` and runs it under `/bin/sh` over that same table, requiring byte-equality with `accountWord`, so the one replication the rule cannot reach is held to it; it reads the fragment by anchor, so moving or renaming it fails loudly rather than silently covering nothing. `packages/core/src/host/check.test.ts` asserts the `lingering` command is what the shared builder returns — an identity, which guards **routing** only: `check.ts` growing its own builder fails it, content is held next door by the literal pins at `:138` and `:465`. `packages/core/src/host/provision.test.ts` splits the message at its colon and requires the tail to equal the builder's output exactly, so a sentence that wraps the command in quotes of its own fails; that message is a **log line**, not operator copy — see the Layering bullet. `apps/web/src/components/self-host-card.test.tsx` reads the quoted command off the rendered card. Nothing stops a new surface interpolating the account itself, and nothing ties `provision-failure.ts`'s operator-facing sentence to any of this — both are review's |
| A command an operator typed refused where they typed it, in the same words at the console and on a schedule | `apps/server/src/instance.test.ts` — drives **Set scheduled command** over HTTP against a real database and compares the whole wire answer: a tab is refused 400 with the contract's own sentence and **no** scheduled command is stored, read back over `listScheduledCommands`, so a refusal that still wrote the row fails there. A second case drives a two-line command and a tabbed one and requires the two answers **the server produced** to differ in message, so collapsing the two sentences fails even if both constants moved together. A third drives the **same** string through `instance.sendCommand` and `instance.setScheduledCommand` and requires the two whole answers to be equal, then requires an ordinary command to be taken by **both** with a 200, so a schema that refuses everything fails there rather than passing on the doors agreeing. A fourth requires a scheduled `!nope` to be refused `INSTANCE_COMMAND_NOT_ALLOWED` at save with nothing stored. `packages/contracts/src/schedule.test.ts` compares the **verdict and the messages** of the two schemas over nine commands, pins the tab, the delete character and the line-break sentences distinct with an ordinary command accepted, requires a command carrying **both** a tab and a line break to raise exactly the line-break sentence — so deleting the `superRefine`'s early return, which raises both, fails there — and asserts the two inputs read one schema object — an identity, which guards **routing** only: a re-declared copy fails it, and it says nothing about what the schema contains. `packages/core/src/instance/instance.controller.test.ts` requires a schedule carrying a client command the manager will not run to be refused with **nothing upserted and nothing audited**, and `!reco` beside it to be stored, so a blanket refusal fails. `apps/web/src/lib/errors.test.ts` compares both sentences whole through `getErrorMessage`, which is what proves a zod message reaches the operator rather than the generic fallback. What it does NOT hold: that `control.ts`'s own control-character throw says anything — it is unreachable from either door now and is left bare, so a row stored before this change still reads `scheduledRunFailure`'s "The command could not be sent", which is true and useless. Nor the rest of `controlLine`'s refusals at save time: only the unknown-command case is driven, not "does not take an argument here". Nor that a **new** input schema looser than a check below it is caught — nothing enumerates them; these were found by reading every `throw new Error(` in non-test `.ts` under `packages/core/src`, `packages/transport/src`, `packages/contracts/src`, `apps/server/src` and `apps/worker/src` (92 at `78a6db7`) together with every throwing `schema.parse(` outside a router (2), and that shape cannot see `reject(new Error(...))` inside a Promise executor, an `Error` built in one place and thrown in another, a `ZodError` raised inside a dependency, or a site that logs and returns rather than throwing. Nor a **byte** bound: `.max(256)` counts UTF-16 code units despite `INSTANCE_COMMAND_MAX_BYTES`'s name, and nothing downstream counts bytes |
| A host marked `removing` only alongside the teardown job that will carry it out | `packages/core/src/host/host.teardown-queue.test.ts` — drives `remove` against a real Postgres and a **real pg-boss**, and reproduces the deployment fault rather than modelling it: it warms `boss`'s queue cache with a real send, deletes the `host.teardown` row from `pgboss.queue` behind it, and lets `send` answer `null`. It asserts on the host row and on `pgboss.job`, never on a thrown class — the host must still read `ready` with a null `teardownRequestedAt`, no `host.teardown` job may carry its id, no `host.teardown.requested` audit row may exist, and `evictHost` must not have run. A second case does the same with the cache cold, where pg-boss throws `Queue … does not exist` instead. A third requires the queue that **did** take the job to leave the host `removing` with exactly one job and its audit row, so replacing the guard with an unconditional throw fails there. `apps/server/src/error-serialization.test.ts` answers the same three shapes over real HTTP through the real router and error formatter, comparing each whole wire answer against one sentence, and adds the two that hold the discriminator: a queue throwing a `TypeError` and a queue rejecting with a value that is not an `Error` must each stay a **500** carrying neither the code nor the sentence, so replacing either guard with an unconditional convert fails. `apps/web/src/lib/errors.test.ts` compares the operator's sentence whole, requires it to promise no wait, to name no queue, job, database, table, row or teardown, and requires no other `ErrorCode` to carry it. What it does NOT hold: that the host row and the job commit together **under a real transaction** at the wire — the server file's `withTransaction` is a pass-through double, so only the core file's real Postgres holds the rollback. Nor a pg `DatabaseError` from the job insert, which the discriminator passes through to the constraint mapping but no test drives. Nor that a **new** caller of `enqueue` gets an honest sentence: `JobNotQueuedError` names a mechanism, and `host.controller.ts` is the only place that turns it into a subject the operator asked for — a second caller would reach the operator as a 500 until it does the same, and nothing enumerates them. Nor the one remaining discarded `sendJob` result, `apps/worker`'s boot-time update check, left alone for the reason the Layering bullet gives |
| The count this table's own sentence states matching the number of rows below it | `check-enforcement-count.mjs` — reads the number word out of the sentence above this table, counts the rows from the header down to the paragraph beginning "Everything else in this document", and fails when the two disagree. A count it cannot read as an English word from zero to ninety-nine fails it rather than passing, and so does a row wrapped onto a second line, because then a line count is not a row count. It holds that arithmetic and nothing else: no part of it checks that a row's claim of enforcement is true. `check-enforcement-count.test.ts` drives the merge that shipped thirty-six rows under a count of thirty-three, and requires a table that agrees at a count other than today's to pass, so a checker comparing against a fixed number fails it |
| No bare `Error` raised anywhere under `packages/core/src` | `check-thrown-errors.mjs`, in `pnpm lint` — parses every `.ts` under that tree that is not a `*.test.ts` and reports every use of the `Error` constructor itself, with `new` or without, thrown or only built, so `reject(new Error(...))` and an `Error` built in one place and thrown in another are caught as well as `throw new Error(`; it exits 1 naming the file and the line. It reads the parse tree, so the constructor named inside a string is not a violation and a class whose name merely ends in `Error` is not one either. It reports a tree that is not there, a tree holding no source file, and a file it cannot parse, rather than passing on having read nothing. `check-thrown-errors.test.ts` gives every one of those guards a case that fails when the guard is removed — measured: the body replaced by an empty result fails 8 of the 17 **with the real tree still exiting 0**, a `walk` that stops recursing fails 7, reporting only throws fails the `reject(new Error(...))` case, widening the exemption from the `.test.ts` suffix to any path naming test fails the four-file case, dropping the empty-tree, missing-tree or parse-error guard fails one case each, and the `import.meta.url === \`file://${process.argv[1]}\`` main guard — the form that made the count gate exit 0 from any path holding a space — fails the path-with-a-space case. One case copies the real core tree into a scratch directory, appends one bare throw, and requires exit 1 naming that file and line, and another requires a directory named `build`, `dist` or `coverage` **inside** that tree to be read rather than skipped, because nothing builds inside `src` and a source directory may carry any of those names. Three cases in `apps/server/src/instance.test.ts` hold the answers these declarations produce, over HTTP against a scripted host: a refused **Save settings** and a refused **Create** each compare the whole wire answer against `HOST_REFUSED`, and a **sealing key the manager no longer holds** must stay a **500** on a console command, naming neither `INSTANCE_COMMAND_NOT_SENT` nor its sentence nor the missing key id — so the one site whose answer this change deliberately moved cannot drift back to a verb's words, nor be swallowed by a later boundary. Measured: with that site a plain `Error` again, the console command answers **400** "The command did not reach this instance". Because it is a whole-directory rule, a file created tomorrow is covered the day it is made, which is what instance-fixing did not give: a journald race fixed at four call sites came back in a file that had not existed when the fix was made. What it does NOT hold: **that the class chosen is the right one** — an `InternalError` picked lazily on a path an operator is waiting on passes it, and no checker can decide reachability honestly; **that any operator reads good copy**, which this proves nothing about; anything outside `packages/core/src`, so `apps/server/src`, `apps/worker/src`, `packages/transport/src` and `packages/contracts/src` may still raise a bare `Error` — the four `reject(new Error(...))` in `packages/transport/src/ssh/` still do, and `failingAs` is written to convert exactly those; a bare `Error` raised inside a dependency, which is how pg's "Connection terminated unexpectedly" and pg-boss's "Queue ... does not exist" arrive; and a `*.test.ts`, exempt because `failingAs` and `acceptAlert` discriminate on `error.constructor === Error` and a test that cannot raise a plain one cannot drive them |
| Every `.mjs` main guard in the repository taking the `process.argv[1]?.endsWith("<filename>.mjs")` form | `main-guards.test.ts` — walks every `.mjs` in the tree rather than reading a list, so a script written next month is covered the day it is made, and fails naming the file and the line of any that compares `import.meta.url` or reads `process.argv[1]` without the suffix naming its own file. It holds the guard's *shape*, not that the main block does anything useful, and it cannot see a script that guards correctly and then checks nothing. Measured: the broken form put back in `check-page-loading.mjs`, `check-runtime-deps.mjs`, `check-image-notices.mjs` and `lint.mjs` leaves the rest of the suite 339/339 green and fails this one alone, naming all four — `lint.mjs` being the severe site, where a regressed guard makes `pnpm lint` exit 0 having spawned none of the eight checkers |

Everything else in this document — the layering direction, the rest of the
tenancy rules, the host-key trust rules in the dashboard — rests on review and
on the tests written alongside each change. No hook, no commitlint, no CI step
covers them.

### `scripts/check-type-policy.mjs`

Runs as part of `pnpm lint` alongside Biome, and its own suite runs under
`pnpm test`: `scripts/` is the `@open-mcc/scripts` workspace package, so the
checker is formatted, typechecked and tested like any other package. It was
none of those things once, and four bypasses survived several review rounds
because the suite that proved the checker worked had never executed. A guard
whose own guard does not run is not a guard.

It scans every `.ts`, `.tsx`, `.mts` and `.cts` file and every `package.json`
under the repository root, skipping `node_modules`, `dist`, `build`,
`coverage`, `.turbo` and `.superpowers` at any depth — the list `biome.json`
excludes, plus `.git`. Change one list and change the other.

`.claude` is the one entry both skip **only at the repository root**, and it is
anchored that way in both files: `biome.json` excludes `!.claude` rather than
`!**/.claude`, and the checker holds it in `SKIP_AT_ROOT` rather than `SKIP`.
The anchoring is load-bearing for the checker's own development, not a
refinement: Biome matches its globs against a path that includes the ancestors
of the project root, so `!**/.claude` matched the *worktree's own path* whenever
a worktree lived under `.claude/worktrees/`, and `pnpm lint` then reported zero
files checked while exiting non-zero. Every agent working in a worktree had to
copy the tree elsewhere to lint it. Neither file may go back to matching
`.claude` at any depth, and neither may stop skipping the root one — the root is
where this repository's own worktrees live, each a full second copy of the tree.
Only the checker's half is pinned by a test; `biome.json`'s rests on review, so
the two can still be made to disagree by editing the config alone.

It works on the parse tree, not on a text search, and that cuts one way only:
a forbidden word inside a string, a template literal or an identifier is not
a violation, and a directive is recognised only in real comment trivia, so
`"@ts-expect-error"` written inside a string suppresses nothing and is not
reported. It does not find assertions "hidden inside" comments, because a
comment contains no assertion. A file that fails to parse is reported as
`parse-error` rather than passing silently, since an unparseable file could
hide anything.

Directive detection mirrors TypeScript's own `commentDirectiveRegEx`
(`^(?:\/|\*)*\s*@(ts-expect-error|ts-ignore|ts-nocheck)`, the compiler's
own pattern widened by `ts-nocheck`), applied to every line of every comment,
so it catches every form the compiler honours: trailing after code on the
same line, `///`, `/** */`, no space after the delimiter, and the closing
line of a block comment, which is the line TypeScript reads. It deliberately
over-catches a few forms the compiler ignores, such as `//// @ts-ignore`. Do not narrow it to the position a directive "normally"
occupies — a directive trailing real code on the same line was the bypass
that lasted longest, because every fixture in the suite had put directives at
column zero on a line of their own.

Two exemptions, both by exact path, never by filename:
`apps/web/src/routeTree.gen.ts` is skipped entirely, and
`packages/db/src/generated/database.ts` is exempt from the comment rule only
— every other rule still applies to it. A same-named file placed elsewhere is
not exempt and must not be made so. An exemption here or in `biome.json` must
name a specific real path, never a bare filename or a wildcard broad enough
to match a file placed somewhere else later; that shape of hole has bitten
this project more than once.

Because the no-comments rule admits no exception, a Biome `biome-ignore`
suppression cannot be written anywhere in the tree. That is intentional: fix
the finding, or add an exact-path exemption and say why in the commit
subject.

Its main block is guarded by `process.argv[1]?.endsWith("check-type-policy.mjs")`,
the form every checker here uses. Do not "tighten" it into a comparison against
`import.meta.url`. Node percent-encodes that URL and resolves it through
symlinks, while leaving `process.argv[1]` exactly as it was typed:
`` import.meta.url === `file://${process.argv[1]}` `` is therefore false from
any path holding a space, which is how this checker and
`check-commit-subjects.mjs` both exited 0 having scanned nothing, and even
`pathToFileURL(process.argv[1]).href` is false under `os.tmpdir()` on macOS,
where `/var` is a symlink to `/private/var`. Only realpathing both sides is
exact, and it buys a throwing filesystem call on `process.argv[1]`, which is
not always a path. The suffix comparison's own weakness runs the other way — a
differently-named file ending in those same characters would fire the gate when
it should not — and a gate that runs when it need not is noise, where the URL
forms are a silent pass. `check-type-policy.test.ts` and
`check-commit-subjects.test.ts` each copy the checker into a scratch directory
whose name holds a space and require exit 1 on input it must reject; both
`file://` and `pathToFileURL` fail that case, measured.

### `scripts/check-commit-subjects.mjs`

Reads `git log` over a revision range and rejects any non-merge commit whose
subject is not `type: subject`, with an optional `(scope)` and a known
Conventional Commits type, or that carries a description at all. Merge
commits are skipped — their message is generated, not authored here. CI runs
it on pull requests over `github.event.pull_request.base.sha..HEAD`, which
is why the checkout uses `fetch-depth: 0`; pushes to `main` are not
re-checked, because the same commits were checked on the pull request that
introduced them. Run it locally with `pnpm check:commits origin/main..HEAD`.

Imperative mood is not checked. It needs judgement rather than a regex, so
that half of the rule stays with review.

## Database

- Kysely, not an ORM with its own query builder abstraction on top. `pg` is
  the driver.
- **Never use a Postgres enum.** A constrained column is `text` in the
  migration, narrowed to a literal union in `packages/db/src/schema/` and
  owned by a `const` array in `packages/contracts`. Adding a value to a
  Postgres enum needs `ALTER TYPE`, cannot be done inside a transaction with
  other statements on older servers, and cannot be reversed; a text column
  plus an application-level union costs one migration only when a check
  constraint exists, and the union is what the compiler enforces anyway. The
  existing `host.status` and `instance.status` columns are the pattern to
  copy.
- `packages/db/src/generated/database.ts` is generated by `kysely-codegen`
  from the live schema and committed — run
  `pnpm --filter @open-mcc/db db:codegen` against a migrated database after
  adding or changing a table, and commit the diff. Never hand-edit that file.
- Files under `packages/db/src/schema/` narrow the generated types (`Omit`
  a column, redeclare it as a literal union or `Generated<...>`) — they
  refine what codegen produced, they do not declare a table's shape from
  scratch. A free-standing hand-written table type is a sign the migration or
  the codegen step was skipped.
- `packages/db/src/schema/host.ts` hand-writes the `HostStatus` union rather
  than deriving it from `hostStatusSchema` in `packages/contracts`, and that is
  deliberate rather than an oversight: `packages/db` depends on no other
  workspace package, and importing the contracts would invert that dependency
  for a five-member union. `kysely-codegen` types the column as `text`, so the
  refinement has to name the members somewhere. Both directions of drift are
  caught by `pnpm typecheck` in `apps/web`, the one place the two types meet: a
  database union wider than the contract's fails where `host.status` is passed
  to `HostStatusBadge`, and a contract union wider than the database's fails on
  `host-status.ts`'s `Record<HostStatus, HostStatusPresentation>`. Do not
  "fix" the duplication by giving `packages/db` a `@open-mcc/contracts`
  dependency; if `apps/web` ever stops routing the status through both, add a
  test comparing the two unions instead.
- Migrations are plain SQL files under `packages/db/migrations/`, applied in
  numeric order by a custom Kysely migrator
  (`packages/db/src/migrator.ts`) that tracks what it has applied in its own
  table. There is no drizzle-orm or drizzle-kit dependency anywhere in this
  repo; the migration filenames just carry the naming convention from the
  tool that originally generated them, before the project moved onto Kysely
  at runtime.
- `packages/db/migrations/0000_reflective_rawhide_kid.sql` is hand-edited
  after that original generation and must stay that way. Its generator could
  only express "null every column of a composite foreign key" on delete, but
  one of those columns is the `NOT NULL organizationId` on `host` and
  `auditEvent`'s actor foreign keys — nulling it on delete fails outright, so
  deleting a member who ever trusted a host key or authored an audit event
  would raise a constraint violation instead of succeeding. Postgres 15+
  lets `ON DELETE SET NULL` name a subset of the composite key's columns;
  the migration's tail narrows the two affected constraints to exactly that.
  Regenerating this migration from scratch will not reproduce the narrowing
  and reintroduces that bug — edit the migration file by hand again instead.
- Integrity constraint violations (SQLSTATE class 23) are a mapped class, not
  a per-call-site concern. `packages/db/src/constraint-violation.ts` classifies
  them off `pg`'s own `DatabaseError`, and `apps/server/src/errors.ts` turns any
  classified violation into a 409: `host_org_name_unique` and
  `sshKey_org_name_unique` carry their own error codes, everything else gets
  `CONSTRAINT_VIOLATION`. Do not wrap repository calls in `try`/`catch` to
  produce a conflict — add the constraint name to that table instead. A
  not-null violation is deliberately left unclassified, because it reports a
  server defect rather than a conflict and must keep returning 500. Deleting an
  ssh key an enrolled host still uses is the one case a controller translates
  itself, into `SshKeyInUseError`: `host_sshKey_org_fk` also fires on insert,
  where it means the referenced key does not exist, and one message cannot
  honestly cover both directions.

## Layering

Dependency direction is one-way: router → controller → repository.

| File | Does | Must never |
| --- | --- | --- |
| `*.repository.ts` | Kysely queries, org-scoped but for `listIds` and the deployment-wide `processIdentity` and `updateState` repositories named under Tenancy | business logic, transport calls |
| `*.controller.ts` | business logic, orchestration | import tRPC or HTTP types |
| `*.router.ts` | tRPC procedures, zod validation, capability check | touch the database directly |

- A query procedure must never resolve to `undefined`. There is no tRPC
  transformer, so `undefined` is not representable in JSON: the key is dropped
  from the response, and TanStack Query rejects the result with "Query data
  cannot be undefined", leaving the query in an *error* state. A UI that
  branches on `data === undefined` then renders the right thing for the wrong
  reason while logging an error on every poll. Controllers may keep returning
  `T | undefined`; the router converts it with `nullWhenAbsent`, and the UI
  branches on falsiness rather than on `undefined`.

- `apps/server/src/routers/member.router.ts` is the one exception to that last
  cell, and it is a standing exception rather than an unconverted file. It
  reads `invitation` and writes `member` directly, in four places, in `invite` and
  `acceptInvitation`, because both operations are inseparable
  from better-auth: the tables belong to better-auth's schema, `invite` calls
  `auth.api.createInvitation`, and `acceptInvitation` calls
  `signupAuth.api.signUpEmail` and must insert the member row in the same
  transaction that consumes the invitation. A controller for it would live in
  `packages/core`, which is framework-agnostic by the rule below and so cannot
  import better-auth; it would have to take both calls as injected function
  dependencies, the way `host.controller.ts` takes `createTransport`. That is
  possible and has not been done — this row is honest about the state of the
  code, not an argument that the state is ideal. Do not read it as licence for
  a new router to query the database: `ssh-key.router.ts` and `host.router.ts`
  both go through controllers, and anything not bound to better-auth's own API
  must too. The router's other procedures do: `list`, `invitations`, `remove` and
  `cancelInvitation` call `packages/core/src/member/member.controller.ts`, which
  takes its one better-auth call, session revocation, as the injected
  `revokeSessions` from `apps/server/src/members.ts`.
- `packages/contracts` owns every zod schema. `packages/core` contains none.
- `packages/core` and `packages/transport` stay framework-agnostic — no
  Hono, no tRPC, no HTTP types.
- **One rule turns an account name into a shell word.** `accountWord`
  (`packages/contracts/src/host-account.ts`) quotes an account the shell would
  otherwise split and leaves every other one alone, and `lingerCommand` beside
  it is the only thing in TypeScript that builds `sudo loginctl enable-linger`.
  Both live in `contracts` because `core` imports `contracts` and never the
  reverse, which is what lets the host check's remediation command and the
  self-host card's copy-and-run command be one string rather than two. There
  were two builders once and they disagreed: the check quoted, the card
  interpolated bare, and an account with a space reached the operator as a
  command naming two accounts, neither of them the intended one. Two of the
  other inputs are worse and are certain rather than argued: `o'brien`
  interpolated bare is an unterminated quote, and an account written as `$(…)`
  runs in the operator's own shell before `sudo` is reached. A sentence
  carrying that command must not wrap it in quotes of its own — the sentence's
  quotes and the rule's are the same character — so `assertLingerEnabled`
  (`provision.ts`) ends its message with the command after a colon and nothing
  after it.
- **That command is built in three more places, and the rule governs only one of
  them.** A shell script that *runs* it puts the account in a quoted variable
  expansion, which the shell never re-splits and never re-scans, so
  `scripts/install.sh` (`sudo loginctl enable-linger "$ACCOUNT"`) and the setup
  script `packages/contracts/src/host-setup.ts` renders
  (`loginctl enable-linger "$account"`) are correct as they stand and are not
  this rule's business. `scripts/self-host.sh` is the one place the two meet:
  it is shell, but it *prints* the command for a person to paste, so the
  account is a literal and double quotes would not save it. It cannot import
  `accountWord`, so it spells the same rule again in `case` and `sed` —
  quoting only `""`, a leading `.` or `-`, or a character outside
  `[A-Za-z0-9._-]`, which is exactly `accountWord`'s condition because the
  head class is the tail class less `.` and `-`. That replication is held
  byte-equal to `accountWord` by a test, not by care.
- **`provision.ts`'s linger message is a log line, not operator copy.**
  `runProvisionTracked` (`host.controller.ts`) replaces the thrown message with
  `provisioningFailureFor(reached?.step)` and passes the original only to
  `deps.onError`, which is `runtimeErrorReporter(logger)`. `provisionHost`
  calls `advance()` for `LINGER_STEP_LABEL` immediately before
  `assertLingerEnabled`, so on this failure the operator is shown
  `packages/core/src/host/provision-failure.ts`'s entry for that step, which
  names no account and so has nothing to quote. Answering a quoting complaint
  about provisioning by editing the message in `provision.ts` would change a
  log line and leave what the operator read untouched.
- **An operator verb's host work sits inside `failingAs`**
  (`instance.controller.ts`), which is provisioning's boundary applied to
  start, restart, stop, sending a console command and reading the console.
  Each wraps what it does on the connection it opens, from connect to close,
  and a plain `Error` or a `HostRefusedError` thrown anywhere inside leaves as
  that verb's own failure class, which `mapKnownError` answers in fixed words.
  Restart's stop is wrapped a second time, so a refused stop reads as a stop and
  not as a start. The discriminator converts a plain `Error` and the one named
  class `HostRefusedError` and nothing else: it rethrows every other subclass,
  so a transport timeout keeps its own sentence and a manager defect such as a
  `TypeError` stays an internal error, and it rethrows anything that is not an
  `Error` at all, which `trpc.ts` then answers as a 500 because it tests
  `cause instanceof Error` before mapping. The plain-`Error` half is still
  load-bearing after `packages/core/src` stopped throwing one: it is what
  converts the `reject(new Error(...))` inside `packages/transport/src/ssh/`,
  and it is also what blames the host for pg's own plain `Error`. Only the non-`Error` half, the
  running sign-in and an unreadable host answer are held by a test — the rest of
  that pass-through rests on review, and the row in the enforcement table says
  what a wrong discriminator still passes. So do not widen it to subclasses, and
  put a new verb's host work inside one. Two things it does not do. Unlike provisioning, the instance
  controller has no `onError` reporter, so the host's own words for these
  failures are recorded nowhere, as they were not before. And a boundary spans
  more than the host: a plain `Error` from a database read or from
  `secrets.open` inside one is blamed on the host, which is a known gap rather
  than a decision.
- **Nothing under `packages/core/src` raises the bare `Error` class**, and
  `check-thrown-errors.mjs` refuses one. The class an author picks is the
  declaration: a named class for anything an operator can be waiting on, and
  `InternalError` (`core/src/lib/errors.ts`) for a manager invariant, a startup
  fault, or a background job nobody is watching. `InternalError` has no case in
  `mapKnownError` on purpose — falling through to `null` already gives the 500 it
  means, and adding a case would only invite operator copy for something no
  operator asked for. Its message never reaches a browser, and on a procedure
  path nothing logs it either — `procedure-span.ts` sets a span status and
  rethrows. Where a background failure is reported, `log/reporters.ts` puts the
  message through `redactError`, whose pattern list is pinned equal to the
  shared one, so a message that names a secret is masked there rather than
  needing care at each throw. The
  general host refusal — a command ran on the host and came back non-zero — is
  `HostRefusedError` (the same file, a leaf both `host/` and `instance/` can
  import without an edge back to a controller). Inside a verb's `failingAs` it
  becomes that verb's own sentence; outside one it answers `HOST_REFUSED`, which
  is what **Save settings**, **Create** and the **host readout** now say instead
  of "Internal server error". **One site moved the other way, on purpose.**
  `sealed-box.ts`'s "No key available for keyId" sits inside the boundaries of
  sending a console command and reading the console, by way of `loadHost`'s
  `secrets.open`. As a plain `Error` the boundary converted it, and an operator
  whose `SEALBOX_KEYS` had been rotated past a stored `privateKeyKeyId` read "The
  command did not reach this bot" — a sentence about the host for a fault that is
  entirely the manager's, and one that would send them to the wrong machine. As
  `InternalError` it escapes the boundary and answers 500, which is what a
  missing sealing key is. That is the one answer this change moved, it is held by
  a test, and it is the reason "`HostRefusedError` is byte-identical inside a
  verb" is a claim about that class and not about the sweep as a whole.
  Provisioning's own sites throw `HostProvisioningFailedError`, which moved to `host/provision.ts` so the file
  that raises it needs no edge back to `host.controller.ts`, and
  `runProvisionTracked` replaces its message with the step's own sentence exactly
  as before. What the checker decides is one syntactic fact and not
  reachability: it cannot tell a lazy `InternalError` on an operator path from an
  honest one, and it reads that one tree only.
- **A host answer the manager cannot read is not a refusal.** Where a command
  came back and the manager could not turn it into a yes or a no — a start
  answer, an environment-write answer, a sign-in probe, the reconcile facts —
  throw `HostAnswerUnreadableError` (`instance/unit.ts`, the leaf beside the
  parsers, so `reconcile.ts` needs no edge back to the controller). It is a
  subclass, so `failingAs` passes it through and the operator reads one sentence
  wherever it is raised, instead of "the host could not start this bot" for a
  bot that may well have started. Empty and malformed are one class here, not
  two: `parseUnitStartState` and `parseEnvWriteAnswer` both answer `undefined`
  either way, so the distinction would have to be invented, and no advice is
  true of every member — the environment case aborts before the unit is touched,
  the start case does not, and the sign-in probe changes nothing — so the
  sentence states the fact and promises no retry. `reconcileHost` catches rather
  than throws, so its member reads as the `unreadable` reason instead of a wire
  error code; the refused-facts branch beside it still reads `interrupted`,
  which is a known lie, not a decision.
- **Work the manager could not accept is its own failure, not the host's and
  not a defect.** Where an operator asks for an alert to be sent and the manager
  cannot write the work down — the queue reports it inserted nothing, or the
  queue call throws on its own — throw `AlertNotQueuedError`
  (`notification/destination.controller.ts`, beside the other destination
  classes). There is no `failingAs` here and there should not be: these two
  procedures are database calls, not a span of host work, the conditions are
  written out in the controller itself rather than buried in helpers, and a
  boundary around `withTransaction` would spread the class over the eight
  procedures beside them where it is false. Only the queue call is wrapped, by
  `acceptAlert`, because pg-boss answers "not inserted" with a `null` and "no
  such queue" with a plain `Error`, and those are one situation to an operator.
  Its discriminator is `failingAs`'s — a plain `Error` converts, every subclass
  and every non-`Error` rethrows — and unlike the earlier pieces both halves are
  pinned by a test. **The reachable `null` is one path, and it is not a
  conflict.** `plans.insertJobs` ends `ON CONFLICT DO NOTHING`, but the partial
  unique indexes that clause can hit (`job_i1`, `i2`, `i3`, `i6`, `i8`) are all
  scoped to a queue policy or a singleton, and these queues are `standard` with
  no `singletonKey` and a NULL `singleton_on`, so no conflict is possible. What
  is left is the statement's `JOIN <schema>.queue q ON q.name = …`: a queue row
  deleted while `boss`'s queue cache is still warm joins to nothing and inserts
  nothing. A cold cache throws `Queue … does not exist` instead, which is why
  both shapes are one class. They are one class with the rows that came back
  empty for the same reason: every site sits inside `db.transaction().execute`,
  so the throw rolls back the notification, the delivery, the requeue and the
  audit entry together, and the operator's outcome is identical in all of them —
  nothing sent, nothing waiting. That rollback is what makes the sentence's
  "Nothing was sent." true, so do not move the queue call out of the transaction
  and do not swallow the failure. The `… insert returned no row` guards in the
  host, SSH key, instance, schedule, command and audit repositories are **not**
  this class — those are plain inserts and `DO UPDATE` upserts, which always
  return a row, so the guard exists to satisfy Kysely and cannot fire. Two sites
  that can fire are left bare on purpose, because no operator is waiting on
  either: the escalation check in `status.controller.ts` and the fan-out in
  `announce.ts` run only under the health poller, and giving them an operator
  sentence would claim a surface that does not exist.
- **A command has one definition, and both doors read it.** `instanceCommandText`
  (`packages/contracts/src/instance.ts`) is what this manager takes as a command,
  and `sendInstanceCommandInput` and `scheduledCommandInput` are the same object,
  not two schemas that agree. They were two, and they disagreed: the console
  refused every invisible character while a schedule refused only `\n` and `\r`,
  so a pasted tab **saved** into a schedule and then failed on every run, reading
  as "The command could not be sent" — the transport blamed for what the operator
  typed. A refusal at the schema is the right answer here rather than a mapped
  error class, because `trpc.ts`'s `sentenceFor` already hands a custom zod
  message to the operator verbatim and nothing has happened yet. The two mistakes
  keep two sentences: a line break says a command is one line, anything else
  invisible says to remove it, and they are one `superRefine` so exactly one
  issue is raised. Do not re-declare either schema beside the other. Beneath
  them, `sendableLine` (`instance/control.ts`) is core's one answer to whether a
  command can be sent at all — the control-character guard, the two-slash
  credential refusal and `controlLine`'s allowlist — and `setScheduledCommand`
  calls it for the same reason the schema exists: a client command this manager
  will not run must be refused when it is saved, not on every run forever. Its
  control-character throw is now unreachable from either door and stays bare on
  purpose: it guards the control FIFO from a second line, it is not operator
  copy, and the only way to reach it is a row stored before this change.
- **A queue insert whose result is discarded is a data-integrity bug, not a copy
  gap.** `createJobQueue.enqueue` (`job.queue.ts`) checks what `send` answered
  and throws `JobNotQueuedError` on a `null`, so the job cannot be lost by a
  caller that ignores a return value — which is how `host.delete` lost it. The
  reachable `null` is one path and it is the alert class's: `plans.insertJobs`
  carries `JOIN <schema>.queue q ON q.name = …`, so a queue row deleted while
  `boss`'s cache is still warm joins to nothing and inserts nothing, while a
  cold cache throws `Queue … does not exist` instead. `enqueue` converts that
  plain `Error` too, under the same discriminator `acceptAlert` uses — a plain
  `Error` converts, every subclass and every non-`Error` rethrows — so a
  `TypeError` raised inside the queue stays a 500 and a pg `DatabaseError` still
  reaches the constraint mapping. `JobNotQueuedError` is deliberately **not**
  exported from `@open-mcc/core`: it names a mechanism, not a subject, and the
  operator's sentence has to name the thing they asked for. `host.controller.ts`
  converts it to `HostRemovalNotStartedError`, which is exported and therefore
  mapped. **Refusing the whole delete is the answer here, not committing and
  reconciling later**, and that was read off what `removing` means rather than
  assumed: nothing sweeps a stranded `removing` host — the only write that
  leaves the status is `deleteAfterTeardown`, called only by the teardown job
  itself, and there is no stale-claim reclaim for it as there is for
  `provisioning`; `host-controls.tsx` disables **Remove** and **Set up** while a
  host is `removing`, so the operator has no lever left; the health poller skips
  it and `host-reader.ts` refuses it, so nothing else would notice. Rolling back
  costs nothing because the teardown's SSH work is entirely the worker's — the
  transaction has touched no host — which is also why "Nothing on it was
  changed." is true. The enqueue stays **inside** the transaction that writes
  `status='removing'` and the `host.teardown.requested` audit entry, for the
  reason the bullet above gives: the rollback is what makes the sentence true.
  Do not move it out, and do not widen it to cover SSH. One further site shares
  the discarded-result shape and is left alone on purpose: `apps/worker`'s
  boot-time `sendJob(SYSTEM_UPDATE_CHECK_QUEUE, …)` commits no state implying a
  check will run, the cron still fires four times a day, and a boot that skipped
  the check heals itself, because `shouldCheckAtBoot` reads `lastCheckedAt`,
  which only the job writes. `reconcileQueues` does verify that queue earlier in
  the same boot, but far earlier — not close enough for proximity to be the
  argument, and it is not the argument.
- The `shellQuote` helpers private to the command builders quote
  unconditionally and are a different rule; do not fold them into this one.
- `PROVISIONING_LEASE_MS` (`host.repository.ts`) must exceed the longest an
  attempt can hold its claim: `CONNECT_TIMEOUT_MS` (`host.controller.ts`) plus
  the timeout (`provision.ts`) of every command `provisionHost` runs — 10s,
  fifteen 15s commands, the 180s client download, the 180s image pull and the
  30s client check, 625s against a 900s lease today. The lease, the connect
  timeout and the three provisioning timeouts live in three files and nothing
  but that arithmetic ties them together, so one more command, or a longer
  timeout, would silently push the worst case
  past the lease: attempt A's claim expires mid-flight, a second actor
  legitimately reclaims the host, and A's `finalizeProvisioning` matches no row
  and throws after A has already changed the remote machine. The budget test in
  `host.controller.test.ts` counts the commands a real `provisionHost` call
  issues rather than a written-down step count, so adding a step fails it.
  Raise the lease, or shorten the steps, before adding one.
- The client download retries, and its three bounds are coupled to the 180s
  that step is given. `clientDownloadCommand` (`provision.ts`) renders a loop
  around `curl` bounded by `DOWNLOAD_ATTEMPTS`, by `DOWNLOAD_DEADLINE_SECONDS`
  recomputed each pass into `--max-time`, and by a backoff that starts at
  `DOWNLOAD_FIRST_BACKOFF_SECONDS` and doubles. The worst case is
  `deadline + first × 2^(attempts − 2)` — the deadline bounds every `curl`, but
  the last backoff is slept **after** the last one and is not inside it — and
  that must stay under `PROVISION_DOWNLOAD_TIMEOUT_MS`, or the exec is killed
  mid-retry and the operator is told the command did not finish rather than
  what the origin said. 170 + 2 = 172s against 180s today. Four numbers in one
  file and a fifth above them, tied by nothing but that arithmetic, so
  `provision.test.ts` reads all four back off the command `provisionHost`
  issues and checks the relationship rather than the values: five attempts
  still fits and passes, six does not and fails.
- **What that retry treats as transient is a decision, not a default.** A 500,
  a 502, a 503, a 408 and a 429, and curl's 6, 7, 18, 28, 35, 52, 55 and 56 —
  DNS, connect, partial file, timeout, SSL connect, empty reply, send and recv
  failure — are retried. **A 404 is not, nor a 403, nor a 401, nor any other
  status or exit**: an artefact that is permanently unfetchable must stay a
  fast, clear failure, and retrying one turns eleven milliseconds into seconds
  of nothing. The classification is read from `-w '%{http_code}'`, which still
  prints under `-f`, paired with curl's exit code. Do not reach for
  `--retry-all-errors` to cover the reset: it was measured, and it turns a 404
  into four requests over seven seconds. Do not reach for curl's own `--retry`
  alone either — it classifies HTTP correctly and leaves a reset connection
  unretried, which is why the loop exists rather than the flag.
- `CONFIG_CLAIM_LEASE_MS` (`instance.repository.ts`) leases one bot's config
  claim for 180s. `claimForConfig` and `claimForLifecycle` take it — the second
  also refuses a live sign-in claim, because start, restart, stop and remove
  must not run under one. **That refusal lasts the sign-in's own lease, 15
  minutes** (`AUTH_LEASE_MS`), and a sign-in whose SSH work ended uncertainly
  keeps its claim for all of it rather than release a stop that may still be
  landing. **Nothing on the row says whether that sign-in is still running**:
  `authClaimId` and `authClaimedAt` record who took the hold and when, never
  whether the work behind it is alive, and `status` cannot stand in — a sign-in
  mid-flight and a sign-in that died leave the identical row, `stopped` with the
  claim held. The only truthful answer is on the host, an SSH connect and an
  exec away, inside the transaction that raises the refusal and on a host that
  may be the reason the sign-in failed. So the refusal does **not** guess: start,
  restart, stop and remove are all refused with one sentence that holds in either
  state and names the bound — "A sign-in is holding this bot. The hold can last
  15 minutes." The minutes are `AUTH_LEASE_MS` itself, which is why that constant
  lives in `packages/contracts` and `instance.repository.ts` re-exports it: the
  copy and the rule cannot say different numbers.
  Where the manager *has* asked the host, it says so with a different code —
  `INSTANCE_SIGN_IN_RUNNING`, raised by `startedOrThrow` off the unit's real
  state. That split is the rule: only a host read may claim a sign-in is running.
  Cancel sign-in is the way out, and the refusal carries it — on the instance
  page, on the instance list and under the command palette alike, one
  `InstanceActionError` renders the same Cancel sign-in button the Danger zone
  holds. **It is offered only to a role that may press it.** `start`, `stop`,
  `restart` and `remove` need `instance.start`; `cancelAuthentication` needs
  `instance.authenticate`, which is owner-only, so an **operator** can raise this
  refusal and cannot end it. Offering them the button would answer `FORBIDDEN`
  and replace the refusal with a permission error, leaving them worse off than
  before; they are told "Ask an owner to cancel the sign-in." instead. A viewer
  cannot reach the refusal at all. Cancel also works only when the host answers:
  it releases the claim *after* its connect and its two execs, so on an
  unreachable host it throws first and even an owner waits the lease out. Saves
  are deliberately still allowed through, on `claimForConfig`.
  `claimForAuth` refuses a live config claim and
  clears a stale one it takes over, so the superseded flow's
  `finalizeConfigClaim` matches nothing rather than writing a status nothing
  else repairs. `writeTokenUnderClaim` renews the lease, so the SSH work still
  to come after a wait on the pool does not run past it. Every stamp and every
  comparison of `configClaimedAt` is the database's `clock_timestamp()` and not
  `now()`, which is transaction start time and therefore older than any wait on
  a row lock: an `UPDATE` queued behind another writer would otherwise commit a
  claim that was already stale when it landed. It follows that
  `configClaimedAt` must never be written from the application clock the way
  `authClaimedAt` and `provisioningClaimedAt` are — `pg` stores a JS `Date` in a
  `timestamp` column as the client's local wall clock while `clock_timestamp()`
  reads the database's, so the two differ by the whole offset whenever the
  server and the database disagree about the timezone. The four writes that run
  under an existing claim — `finalizeConfigClaim`, `releaseConfigClaim`,
  `writeTokenUnderClaim` and `deleteUnderClaim` — match on the claim id alone,
  with no freshness test, exactly as `finalizeProvisioning` does: refusing a
  late one would leave a host holding a token its row lacks, or strand a row
  whose tree is already gone. A settings or a bots save takes it: one short
  transaction claims the row, compares the stored version against the
  `expectedVersion` the form posted, composes the merged document and re-parses
  it, so a stale save, a busy bot or an unusable document rolls the claim back
  before the host is touched at all. The write then runs with no transaction
  open, and a second short transaction finalizes the claim, records the version
  and writes the audit event. A removal takes it too, through
  `claimForLifecycle`: the claim commits before the host is touched, all six
  removal steps run under it, and `deleteUnderClaim` carries the claim away with
  the row, so no save and no sign-in can slip between the stop and the second
  verify. Start, restart and stop take it through `claimForLifecycle` as well:
  one connection serves the whole operation, every exec runs under the claim,
  and the status is part of the same `UPDATE` that gives the claim back, so a
  manager stop and a manager start can no longer leave the row saying `running`
  over a stopped unit. A start issued while a removal holds the claim is
  refused as busy. Creation takes the claim in the `INSERT` itself rather than
  in a statement after it, so the row becomes visible already carrying a claim
  id and a `clock_timestamp()` stamp and there is no instant at which a bot
  still being built is free for a save, a start, a restart, a stop, a removal or
  a sign-in. Its four layout steps run under that claim and one pooled
  `finalizeConfigClaim` gives it back, with no status and no audit event beside
  it because the insert's own transaction already wrote both. A creation that
  fails partway leaves the row and its version 1 behind, as it always did, and
  leaves the claim with them for as long as the keep rule below holds it. Past
  the lease another actor can take the row over, and creation's finalize then
  matches nothing and reports the create busy. The bot exists by then, so an
  operator who retries the create gets a second bot on a second port rather
  than the one they meant to finish. What the claim excludes is every other
  *manager* actor, not the host's own systemd — a sleep timer or a
  `Restart=on-failure` start is still unclaimed — which is why a removal goes
  on relying on the timer step, the stop that cancels a `Restart=on-failure`,
  and the second verify.
  A start rewrites `env` only when the host reports the unit stopped: the same
  exec that would write the file first reads `ActiveState` against
  `RUNNING_UNIT_STATES`, answers `kept` for any running state — `activating`
  included, so a client systemd is still starting keeps the token it read — and
  the row's token is written only on a `written` answer, so a `kept` answer can
  never leave the row holding a token the host does not have. The opposite
  direction — the host holding a token the row lacks, which makes live control
  401 until the next Restart — is **not** closed, and there are four ways to
  reach it, all of them around the env exec: it resolves non-zero after the
  rename; it rejects, so whether it landed is unknown; it resolves but prints
  neither `kept` nor `written`; or it prints `written` and
  `writeTokenUnderClaim` then matches nothing because another actor took the
  claim. The first three leave `env` old, new or torn and the row's token old;
  the fourth leaves `env` new and the row's token old. All four refuse the
  start rather than report success, and the recovery is a Restart.
  A lifecycle operation refused with no live sign-in is `InstanceBusyError`;
  one refused by a live sign-in is `InstanceAuthInProgressError`. `remove`,
  `start`, `restart` and `stop` all take that split through
  `takeLifecycleClaim`, and it is decided by a re-read because
  `UPDATE ... RETURNING` cannot tell a gone row from a held one. A failure the manager can see the end of releases
  the claim; one that could still be running on the host keeps it until the
  lease expires, because releasing it would let a second writer race a command
  that has not finished.
- Each step's wait is sized from what that step's own remote work can take, not
  only against the lease above it. The stop has always been: `UNIT_STOP_TIMEOUT_MS`
  is 45s against the unit's `TimeoutStopSec=20`, twice over because systemd arms
  that timer once for `ExecStop` and again for the kill that follows. **The start
  was not**, and a start merely waiting out the collector's `collect.lock` tripped
  the ordinary 15s step wait while the unit went on to reach `active` — the
  channel was destroyed, `claimedExec` set `inFlight`, the claim was correctly
  kept for the rest of the lease, and the row was left `stopped` over a running
  bot. Reproduced on a sandbox host, not reasoned: a lock held five seconds past
  the step wait, the start refused, `INSTANCE_BUSY` on the retry, and
  `Started open-mcc@…` in the unit's own journal.
  Three ordered numbers fix it, and the order is the whole point:
  **start phase 55s < `JobTimeoutSec=60` < `UNIT_START_TIMEOUT_MS` 75s.**
  The unit's `[Service]` carries `TimeoutStartSec=25`, so its start phase is
  bounded by the `flock -w 30` its own `ExecStartPre` declares plus 25s for the
  container — 55s. That sum is deliberately loose: `TimeoutStartSec` also caps
  the flock exec, so the real bound is 50s, but summing the two *declared*
  numbers stays an upper bound if `TimeoutStartSec` is ever raised above the
  `-w`, and the tests compare against the declared pair.
  `JobTimeoutSec=60` sits above that as a backstop. It sets **both**
  `JobTimeoutUSec` and `JobRunningTimeoutUSec` — measured: `JobTimeoutSec=6`
  reports `JobTimeoutUSec=6s JobRunningTimeoutUSec=6s` — so it bounds the time
  the job spends *queued*, behind `network-online.target`, which
  `TimeoutStartSec` does not cover at all, and the time it spends *running*,
  which is the bound that actually fires in the four-exec residue below.
  `UNIT_START_TIMEOUT_MS` (`unit.ts`) is
  `JobTimeoutSec` plus `INSTANCE_STEP_TIMEOUT_MS` — the ordinary wait this
  repository gives any one exec, which is what the SSH round trip and the two
  `systemctl show` reads `startUnitCommand` chains after the start amount to. A
  start spends 115s of the lease, a restart 160s.
  **`TimeoutStartSec` is the load-bearing one; `JobTimeoutSec` alone would not
  do, and it is important to know why.** A job timeout cancels the *job* and
  leaves the *unit* starting. Measured: a `Type=notify` unit with a 70s start
  phase and `JobTimeoutSec=60` gives `systemctl start` exit 1 at 60s with
  `Result=success ActiveState=activating SubState=start-pre`, and reaches
  `active` at 70s regardless. That resolves the exec non-zero rather than
  rejecting it, so `claimedExec` leaves `inFlight` false and the claim is
  **released** — the manager reports a failure, lets go, and the bot comes up
  behind it. `TimeoutStartSec` instead fails the unit: the same unit with
  `TimeoutStartSec=25` gives exit 1 at 25s with `Result=timeout`. Only then is
  the release correct, because the work the manager *commanded* has ended.
  **It does not stay failed, and a reader must not assume it does.** The
  instance unit carries `Restart=on-failure` and `RestartSec=30`, so a unit that
  has just failed its start phase reports
  `Result=timeout ActiveState=activating SubState=auto-restart` — not `failed` —
  and systemd makes a fresh attempt 30s later, which on a host whose lock has
  since been freed **starts the bot 30s after the manager reported failure and
  released the claim**. That is not a hole in the release rule: the claim
  excludes other *manager* actors, never the host's own systemd, exactly as a
  sleep timer or any other `Restart=on-failure` start is unclaimed, and the
  result surfaces as `stateDrift` at the next reconcile. It is why the sandbox
  test reads the verdict off `Result` rather than `ActiveState`.
  The honest caveat: `TimeoutStartSec` is re-armed for **each** exec in the
  start phase — under `TimeoutStartSec=5` two `ExecStartPre=/bin/sleep 4` ran
  eight seconds and succeeded — and `ExecCondition` is subject to it too
  (`TimeoutStartSec=5` against `ExecCondition=/bin/sleep 20` failed the unit at
  5s). So the *strict* worst case is the number of start-phase execs times
  `TimeoutStartSec`, 100s, not 55s. 55s is the practical bound and rests on a
  judgement: of the four execs only the `flock` and the `podman run` wait on
  anything, the other two being a local `systemctl show` and three `test`
  builtins. In the pathological case the job timeout fires at 60s and leaves
  the unit activating, which is the residue this design does not close.
  Do not reorder those three numbers. Raising `TimeoutStartSec` past
  `JobTimeoutSec` minus the lock wait puts the job timeout back in front of the
  phase timeout and restores the released-claim defect; raising `JobTimeoutSec`
  without raising `UNIT_START_TIMEOUT_MS` with it restores the original one.
  `flock -w 30` is bounded by `TimeoutStartSec` as well as by its own `-w`, so
  with 25s the `-w 30` is never reached. The lock itself costs little — the only
  holder is the collector's truncate under `withDeadline(2, 10, …)`, 12s — but
  **that 25s is not all lock wait**, and the rest of it is measured rather than
  assumed. The same `ExecStartPre` goes on to `rm -rf` the recording cache and
  remake it inside the same 25s. That delete carries **no deadline of its own
  and needs none**: run as a real user unit under `TimeoutStartSec=25` on a
  sandbox host, the whole step costs 6ms on an empty cache, 353ms against one
  32 GiB recording and 311ms against 10,000 leaked runs — 30,001 entries —
  `Result=success` every time. The size of a recording is the wrong thing to
  fear, because **the cost follows directory entries, not bytes**: unlinking
  frees extents rather than blocks, so on ext4 with a cold page cache a 32 GiB
  recording costs 13ms and **one** blocking read — 66ms with a competing writer
  saturating the disk — while 10,000 run directories cost 1.57s and 5,516 of
  them. Entries are what the client's own shape bounds: `ReplayHandler` makes
  one directory per recording holding `recording.tmcpr` and `metaData.json`, and
  this step empties the cache at **every** start — including every
  `Restart=on-failure` attempt, which re-runs the whole start phase — so what it
  finds is what one run left, not a fleet's history. On those filesystems
  reaching 25s needs on the order of two million entries, or a single recording
  in the terabytes. **That figure is a property of ext4, btrfs and overlay2, not
  of the delete**: on NFSv4.2, where every entry costs round trips, 3,001 entries
  took 8.1s, 61.7s and 112.7s at 0, 1 and 5ms of added latency, which puts 25s
  near 1,200 entries — while the four-entry shape a real cache has is 270ms even
  at 5ms. Rootless Podman's storage all but rules an NFS home out, but a reader
  proposing one should know the cost model changes there and nowhere else.
  **A cleanup that never runs is the way entries could accumulate**, and it is
  why the sentence is "what one run left" rather than "one hard kill's leak":
  `ReplayHandler` calls `CleanupWorkingFilesUnsafe` *after*
  `WriteReplayArchiveUnsafe` inside the same `try`, on both the `/replay stop`
  path and the process-exit one, so a full disk, a quota or a read-only
  `replays/` skips the cleanup and nothing retries it; and `Program.Restart()`
  re-initialises the bots in-process, so every reconnect builds a fresh working
  directory. With `ChatBot.AutoRelog.Retries = -1` and a `Delay` the client
  floors at 0.1s — both keys an operator can set through this manager — a bot
  looping against a full disk leaves one directory per reconnect. It is still
  three entries each and still emptied at the next start, so it does not reach
  the numbers above on any local filesystem; it is stated because the entry
  bound is what the measurements rest on.
  **A `timeout -k` here would buy nothing, and the contrast with removal and
  teardown is the reason.** Those deletes are wrapped because nothing else
  bounds them: the manager's wait ends a *channel*, not a host-side `rm`, so
  without `withDeadline` the host goes on deleting after the manager has given
  up and the failure is never legible. In a unit the bound already exists and is
  this repository's own — `TimeoutStartSec` ends the exec and fails the unit. A
  second number inside it cannot make a slow delete fit; it would only fail the
  same start sooner, and add a fourth number to an ordering whose three are
  load-bearing. If the cost ever did start to matter, the remedy is not a
  deadline but a **rename**: move the cache aside, remake it, and delete the old
  one in the background, which makes the start phase O(1) in entries instead of
  bounding a cost it cannot change. Nothing measured asks for that today.
  What the step must do instead is fail **visibly**, and the `&&` is what makes
  it: `rm -rf … && mkdir -m 0700 …` refuses the start both when the delete only
  half succeeds — leaving the rest where an operator can see it — and when it
  fails having taken everything, where a `;` would read success off the empty
  path and start a client behind a delete that reported failure.
  The **floor** on `TimeoutStartSec` is held only by the sandbox suite, not by
  `pnpm test`: `runtime.sandbox.ts`'s "starts a bot whose collect.lock is held
  past the ordinary step wait" holds the lock past `INSTANCE_STEP_TIMEOUT_MS`
  and requires the start to survive it, so shaving `TimeoutStartSec` to 10 fails
  it with `start-pre operation timed out. Terminating.` while the unit suite
  stays green. The ceiling is held by `unit-template.test.ts`. Do not treat the
  sandbox job as optional: without it this constant is pinned from above only.
  How the three numbers *relate* is tested both ways; how the load-bearing one
  is **sized** rests on one empirical anchor — the collector's 12s truncate —
  which covers the flock exec and not the other blocking one. `ExecStart` is
  `podman run -d --sdnotify=conmon`, returning on conmon's `READY=1`, and no
  measured number stands under it; 25s is judgement against a start that takes
  well under a second on every sandbox host.
- **Re-provisioning caps every start-phase exec at 25s where it had 90, and that
  is a real widening, not only a narrowing.** A host whose `podman run`
  legitimately needs longer than 25s now fails its start where it previously
  succeeded. With `RestartSec=30`, `StartLimitBurst=5` and
  `StartLimitIntervalSec=600`, such a host burns five attempts in roughly 275s
  and then refuses to start at all until the limit
  interval passes or an operator runs `reset-failed`. The 60-70s band the
  previous shape had is genuinely gone rather than moved, and this replaces it —
  but it differs in kind, and that is why the trade is right: the new failure is
  **honest** (the unit is failed, the exec resolved, the claim is released
  correctly and the row is consistent with the host), where the old one left the
  row saying `stopped` over a running bot with the claim held for three minutes.
  A host that hits this is misconfigured or under load in a way an operator
  should see. The `rm -rf` half of it was measured and is not the risk — the
  numbers are above — so what is left in this band is the `podman run`, where no
  measured number stands under the 25s at all.
- **A sign-in's start is bounded from the sign-in unit's own numbers, not the
  bot unit's.** `open-mcc-auth@.service` carried the same
  `ExecStartPre=/usr/bin/flock -w 30` with nothing above it, and
  `startAuthCommand` ran under `AUTH_SESSION_TIMEOUT_MS`, 30s — so the declared
  lock wait alone could consume the whole manager-side wait, leaving nothing
  for the container. Reproduced on a sandbox host with `collect.lock` held five
  seconds past that wait, and it is worse than the bot unit's case was: the exec
  **rejected** at 30.3s, `claimedExec` set `inFlight`, and the claim was
  correctly kept — for `AUTH_LEASE_MS`, fifteen minutes, not three. What the
  operator saw: the sign-in itself reported "The host did not answer in time.
  Try again in a moment." — `CommandTimedOutError` extends
  `TransportInterruptedError`, which `mapKnownError` answers
  `HOST_NOT_ANSWERING` — which is true of the exec and says nothing of the claim
  it left behind; then start, restart, stop and remove were every one of them refused
  `INSTANCE_AUTH_IN_PROGRESS`, whose copy then named no duration and asserted a
  sign-in was under way, while the unit had in fact failed within a second of the
  manager giving up and the cleanup's `reset-failed` had already wiped that
  evidence. That copy is fixed under `CONFIG_CLAIM_LEASE_MS` above, and Cancel
  sign-in now sits in the refusal rather than only in the Danger zone.
  Three ordered numbers fix it, and as on the bot unit the order is the point:
  **declared pair 50s < `JobTimeoutSec=55` < `AUTH_START_TIMEOUT_MS` 85s.**
  The sign-in unit's start phase is four execs, and `TimeoutStartSec` re-arms
  for each: the `ExecCondition` that skips a running bot, the settings
  preflight, `flock -w 30 … /bin/true`, and `podman run -d --sdnotify=conmon`.
  Only the third waits on anything a third party holds, and `TimeoutStartSec=20`
  bounds every one of them.
  **The 50s is not the phase, and nothing should read it as one.** It is the sum
  of the two numbers the unit *declares*, `-w 30` and `TimeoutStartSec 20`, and
  it is a deliberate over-estimate: the per-exec bound caps the lock exec at 20s
  so the `-w 30` is never reached, which puts the phase at **at most 40s** for
  the two execs that wait and at most 4x20 = 80s strictly. The tests compare the
  declared pair because that sum stays an upper bound on the practical phase
  even if `TimeoutStartSec` were ever raised above the `-w`. What the comparison
  buys is a ceiling: `lock + start < job` caps `TimeoutStartSec` at 24, and so
  caps the practical two-exec phase at 48s, still under the job bound.
  **How 20 is arrived at.** Its floor is the longest a single one of those execs
  can legitimately take. For the lock exec that is the collector's truncate, the
  only holder in this product whose hold is bounded: it takes `collect.lock`
  with `flock -n 9` inside `withDeadline(TRUNCATE_KILL_AFTER_SECONDS,
  TRUNCATE_DEADLINE_SECONDS, …)`, so 12s. For the rest, measured: three
  consecutive uncontended starts of this unit on a Debian 12 sandbox host took
  **98ms, 67ms and 70ms** for the *whole* phase. The 8s left over is therefore
  judgement, not derivation — but unlike the bot unit's 25s there is nothing
  unbounded inside it to cover: this unit's lock exec runs `/bin/true`, not an
  `rm -rf` of a cache whose size nothing bounds. 20 also sits **below** the
  `-w 30`, so the phase bound fires first and the lock exec ends `Result=timeout`
  rather than `exit-code`; both resolve the exec, so both fall on the release
  side of the claim rule, and the difference is diagnostic only.
  `JobTimeoutSec=55` sits above the declared phase as a backstop. Measured on
  this unit: unset it reports `JobTimeoutUSec=infinity
  JobRunningTimeoutUSec=infinity TimeoutStartUSec=1min 30s`, and
  `JobTimeoutSec=6` reports `JobTimeoutUSec=6s JobRunningTimeoutUSec=6s` with
  `TimeoutStartUSec` untouched — one directive, both bounds, and it is the
  running-time one that fires in the residue below. The 5s gap above the phase
  is margin for queue time, which nothing here measures; this unit declares no
  `After=`, so it queues behind nothing it waits on, and only the **sign** of
  that gap is load-bearing.
  `AUTH_START_TIMEOUT_MS` (`authenticate.ts`) is `JobTimeoutSec` plus
  `AUTH_SESSION_TIMEOUT_MS` — the wait this file already gives any one exec on
  this path, which is what the SSH round trip and the `rm -f …/auth.log` that
  `startAuthCommand` chains before the start amount to.
  **`AUTH_SESSION_TIMEOUT_MS` is deliberately not raised.** Ten call sites share
  it — both other connects, both stops, the session-cache probe, the ten `cat`
  polls and two cleanups — so a bare bump would inflate all of them to buy one
  step its margin. A whole failing `beginAuthentication` now spends
  30 + 45 + 30 + 85 + 10x30 + 18 of sleeps + 30 = **538s** under the claim,
  against a 900s lease.
  The residue: with `TimeoutStartSec` re-armed per exec the *strict* worst case
  is four execs times 20s, 80s, past `JobTimeoutSec`, and a job timeout leaves
  the unit activating with the exec resolved — the manager would release the
  claim over a sign-in still starting. It rests on a judgement that this is
  unreachable: two of the four execs are a local `systemctl show` and four
  `test` builtins, so the practical phase is 20 + 20 = 40s.
  Re-provisioning caps every start-phase exec at 20s where it had systemd's 90,
  so a host whose `podman run` legitimately needs longer now fails its sign-in
  where it used to succeed. Two of the bot unit's residues are absent here, and
  both for the same reason — this unit declares no `Restart=`, so there is no
  start limit to burn, and systemd never makes a fresh attempt half a minute
  after a failed start. The operator presses the button again. That is **not** a
  claim that nothing can be running once the manager has reported failure: the
  job-timeout residue above is exactly that case, and in it the `ExecStart`
  child is still alive.
  One floor this design does **not** own: the bot unit's own start-phase `flock`
  also holds `collect.lock`, for as long as *that* unit's start phase allows. A
  sign-in that waits behind it needs both units' `ExecCondition`s to have passed
  before either reported `activating`, which the two conditions make narrow but
  not impossible; if it is hit the sign-in fails honestly and is retried. Do not
  raise the bot unit's `TimeoutStartSec` without asking whether this 20s still
  clears it.
- **A sign-in's start is checked, because a start that never ran cannot be told
  from a client that said nothing once the exec is thrown away.**
  `startAuthCommand` is `rm -f …/auth.log && systemctl --user start …`, and its
  result was discarded, so a refused start fell into the device-code poll and
  reported "did not present a device code" ten polls and twenty seconds later —
  a sentence about a start that succeeded and stayed quiet. Worse, the `rm -f`
  is the *first* half of that chain: when it fails the start never runs and the
  **previous** attempt's `auth.log` is still there, so the poll would find the
  old code and `beginAuthentication` would **return** it — a false success, the
  row moved to `needs_auth` and the operator typing a code minted for a session
  that no longer exists. Checking `exitCode` closes both.
  **What the exec can see is the whole of `ExecResult`: `exitCode`, `stdout`,
  `stderr` — never `Result`, `ActiveState` or `SubState`.** Measured on a real
  systemd 252 user manager, Debian 12, against units shaped like this one:

  | what happened | exit | what the unit says (invisible to the exec) |
  | --- | --- | --- |
  | the settings preflight exits 1 | 1 | `Result=exit-code ActiveState=failed` |
  | the start phase timed out | 1 | `Result=timeout ActiveState=failed` |
  | `JobTimeoutSec` fired first | 1 | `Result=success ActiveState=activating SubState=start-pre` |
  | the unit is not on the host | 5 | — |
  | the `rm -f` failed, so `systemctl` never ran | 1 | untouched |
  | `ExecCondition` skipped the start | **0** | `Result=success ActiveState=inactive` |

  So the exit code answers exactly one question — *did the start succeed* — and
  the manager says only that. It does **not** say which of the five non-zero
  rows above it was:
  systemd's stderr distinguishes them in prose ("failed because a timeout was
  exceeded" against "failed because the control process exited with error
  code"), and nothing here pins that wording or treats it as a contract, so it
  is put in the thrown `Error` for the server log and never parsed. **The last row is the
  residue**: a start systemd skipped because the bot unit is running exits 0 and
  is indistinguishable from one that ran, so it still reaches the poll and still
  reports no device code. That is not closed here, and the message stays correct
  for it — the client genuinely presented nothing.
  **The claim is released, and the keep/release rule is untouched.** The exec
  *resolved*, so `claimedExec` leaves `inFlight` false and the existing catch
  releases; no code decides this, which is the point. It is also correct rather
  than merely convenient: a failed start resolves the exec at the moment the
  unit reaches `failed` — measured at 5211ms against a `TimeoutStartSec=5` — and
  this unit declares no `Restart=`, so nothing brings it back. The one case
  where the exit is non-zero over a unit still *starting* is the `JobTimeoutSec`
  row above, and the catch path's `stopAuthCommand` ends it before the release:
  measured, the stop took **9ms** from `ActiveState=activating SubState=start-pre`
  to `inactive`, and it stayed there. Do not reorder the cleanup stop and the
  release.
  **Both ends of the sign-in now have a sentence, and neither had one before.**
  `mapKnownError` answers a bare `Error` `null`, `GENERIC_UNMAPPED` holds only
  `UNAUTHORIZED` and `FORBIDDEN`, so `trpc.ts`'s formatter substituted
  `GENERIC_INTERNAL_MESSAGE`. Most of `beginAuthentication`'s failures were never
  affected — `InstanceHostNotFoundError`, `HostUnreachableError`, a channel limit
  and a transport timeout all had mappings already. What read **"Internal server
  error"** was the one failure it raised as a bare `Error`: the device-code
  sentence this file has carried since it was written, which therefore never
  reached a dashboard at all. The start's refusal was not raised at all.

  | what happened | code | the operator reads |
  | --- | --- | --- |
  | the host refused the start | `INSTANCE_SIGN_IN_DID_NOT_START` | "The sign-in did not start on the host. Try again in a moment." |
  | the start worked, no code came | `INSTANCE_SIGN_IN_NO_DEVICE_CODE` | "The sign-in started but no device code appeared. Try again." |

  The split is the exit code and nothing else, and the two sentences differ in
  their advice on purpose: the likeliest refused start is the collector holding
  `collect.lock`, bounded at 12s, so **in a moment** is a real instruction; an
  empty polling window has no clock under it — an auth-service outage, a network
  fault reaching Microsoft, a client that exited early — so it says **Try
  again** and does not promise a wait that would help.
- **An SSH exec that resolved non-zero is a `BAD_REQUEST`; one that did not
  resolve at all is a `CONFLICT`.** This is a rule about **exec-level** failures
  only — the `claimedExec` calls this manager issues over SSH and reads an exit
  code from — and it is **not** a rule about `mapKnownError` as a whole. Within
  that scope it holds both ways:
  - resolved non-zero → `BAD_REQUEST`: `instance.controller.ts`'s removal tests
    `(await claimedExec(…)).exitCode !== 0` and raises
    `InstanceRemovalFailedError`; `HostProvisioningFailedError` is the same
    shape; both sign-in refusals now join them.
  - never resolved → `CONFLICT`: `HOST_NOT_ANSWERING`,
    `HOST_COMMAND_INTERRUPTED`, `HOST_CHANNEL_LIMIT` — the manager does not know
    what the host did, which is the same uncertainty that makes `claimedExec`
    set `inFlight` and keep the claim.

  **Do not widen this into "the host answered no means 400".** Two mappings in
  the same file are exactly that and are `CONFLICT`: `action_failed` →
  `INSTANCE_LIVE_ACTION_FAILED`, *"The client tried, but the game did not let
  it."*, three lines from `invalid_args` → `BAD_REQUEST`; and
  `McpProtocolError`/`LiveResponseTooLargeError` →
  `INSTANCE_LIVE_CONTROL_UNREADABLE`, where the manager *did* get an answer and
  only failed to parse it. Those are live-control refusals the client itself
  raised, not exec exit codes, and they are outside the rule rather than
  exceptions to it. Anyone restating this as a whole-file convention should
  first enumerate **all** of `mapKnownError`, including the two tables it
  returns from rather than inlines — `REFUSALS`, reached at the first line of
  the function, and `CONSTRAINT_VIOLATIONS`, reached at the last. A reading that
  matches only `if (cause instanceof …) return mapped(…)` misses both, which is
  how the over-broad first draft of this bullet was written.

  The 400/409 split is **not observable on the dashboard**: the only reader of
  `httpStatus` outside tests in `apps/web` is `wasRefused`, which takes the whole
  400–499 band alike. So no symptom holds it, and the test is the only thing that
  does — it requires the three exec-level failures it names to be `BAD_REQUEST`
  and a transport timeout and a live sign-in to stay `CONFLICT`, in one
  assertion, so moving either side of the line fails it. It does not cover
  `HOST_PROVISIONING_FAILED`, which is named above as the same shape but is
  pinned only by its own existing test.
- `provision` verifies what it needs under the advisory lock and *before* the
  claim, so a rejected attempt leaves no claim behind and the operator's host
  is exactly as they left it. The ssh key lookup is the deliberate exception:
  it stays above the transaction because a host pointing at a deleted key has
  to fail with nothing claimed, and moving it below would strand that host
  `provisioning` behind a live lease until it went stale — a worse outcome, on
  a reachable path, than the one it would close. So the key is read early and
  the row is re-read under the lock, where `hostKeyFingerprint` and `sshKeyId`
  are checked; either failing aborts before `claimForProvisioning` runs.
- The status handed to `claimForProvisioning` is deliberately the *pre-lock*
  read, never the row just re-read under the lock. That comparison is the
  optimistic concurrency check: the claim must fail when the status moved
  between the operator's read and the claim. Substituting the freshly-read
  value looks like deleting a redundant variable and quietly makes the claim
  always succeed.
- One check stays after the claim because it cannot move: a claimed row
  carrying no `provisioningAttemptId` tests what the claim itself wrote.
  `claimForProvisioning` always writes one, so that is an impossible state and
  a server defect — it throws a bare `Error`, returns 500, and leaves the host
  `provisioning` until the lease goes stale. That is a signal rather than a
  false report, which is why it does not write `error` on the way out.
- Remote effects (an SSH connection, a call into better-auth's own write
  path) never sit inside a database transaction. `host.controller.ts`'s
  `provision` claims the host with a leased status update, does the SSH work
  entirely outside any transaction, then finalizes in a second transaction —
  a crash mid-attempt leaves a recoverable claim, not a hung lock.
  Evicting a host's shared read connections is network I/O too, so re-trust
  and host removal evict only after their transaction commits.
  `member.router.ts`'s `acceptInvitation` calls better-auth's `signUpEmail`
  (a connection this codebase does not control) before opening the
  transaction that inserts the member row and audits it. When that
  transaction refuses the invitation, because it was cancelled or its inviter
  removed while the accept was in flight, the account this request just created
  is deleted through better-auth's `internalAdapter` before the refusal is
  returned, so the email can be invited again. Only that known refusal deletes:
  any other failure after signup leaves the account with no membership, which
  reaches no tRPC procedure because the request context rejects a session with
  no matching member row, but whose email is refused as already having an
  account until an operator deletes it from the database. A
  formal saga engine with idempotency keys and per-phase checkpoints is
  scoped for later and does not exist yet.
- `member.router.ts`'s `invite` is the one write whose audit row can be lost
  without the write being lost with it. The write is
  `auth.api.createInvitation`, better-auth's own call, which cannot sit inside
  a transaction by the rule above, and there is no second statement to pair the
  audit with — so an audit insert that fails leaves an invitation with no
  `member.invite` row. Every other audited mutation commits its audit row in
  the same transaction as its write. Closing this needs the injected-dependency
  controller the `member.router.ts` row above describes, not a transaction
  around the audit alone.

## Tenancy

Every table carries `organizationId`, except the deployment-wide `processIdentity`
and `updateState` named below. Every cross-entity foreign key that
crosses into another organization-scoped table is composite and includes it
(see `host_sshKey_org_fk`, `auditEvent_actor_org_fk` in the migrations).
Actor columns reference `member`, never the global `user`, except an audit
row's `actorLabel`, which is a label captured at the time of the action, not
a live reference, and survives the member being deleted. Repositories take
an organization scope (`{ organizationId }`) as a required first argument on
every method but `listIds` and the deployment-wide `processIdentity` and
`updateState` repositories named below, and that includes `host.repository.ts`'s `lockHost`,
which takes no organization predicate but folds the organization id into the
advisory lock key so one tenant cannot stall another's host that happens to
share an id. The compiler is what enforces this: a method without the scope
parameter cannot be called without one.

`organization.repository.ts`'s `listIds` is the one exception that reaches
tenant data, and must stay the only one; the deployment-wide `processIdentity`
and `updateState` repositories below reach none. It enumerates the global `organization` table so the fleet-wide
retention worker can iterate tenants and then call organization-scoped methods
for each; the `organization` table carries no `organizationId` column, so
there is nothing for a scope to bind to and a scope parameter would be
decoration. Its safety rests on reach rather than on a predicate: it returns
organization ids and nothing else, its only caller is internal fleet-wide
background work (`apps/worker/src/bootstrap.ts`, wiring
`createCleanupHandler`), and it is reachable from no router and from no other
actor-facing path. Never give it one — a procedure returning that list would
tell one tenant that every other exists. Nothing else in this section is
relaxed by it.

`processIdentity` and `updateState` are the two tables with no `organizationId`,
and their repositories take no scope. That is not a second `listIds`: those
tables hold nothing an organization owns. Each records a fact about the
deployment — which build and schema a daemon runs, and what the release check
last found — and under `SECURITY.md`'s one security domain per deployment, two
organizations cannot coherently disagree about either. `updateState` holds
exactly one row, and the `updateState_singleton` check constraint is what makes
that true rather than a convention. Neither table may gain a column naming an
organization or anything an organization owns; a fact that belongs to
a tenant belongs in a scoped table.

## Auth

Registration is closed by two independent controls, and the second is the one
that carries the guarantee. `emailAndPassword.disableSignUp` shuts better-auth's
own `/sign-up/email` endpoint on every mounted instance, and that is the whole
of what it can do: it is a plain boolean read once when `betterAuth()` is
constructed, so it cannot express "open until the first account exists", and it
sits under `emailAndPassword`, so it governs that one method. Google, OIDC,
SAML, passkeys, magic links, email OTP and every future plugin route around it,
which is why a gate built on it alone would open a hole the day any of those
ship.

The control that closes those is `user.validateUserInfo`
(`apps/server/src/security/registration-gate.ts`). better-auth calls it from
`internalAdapter.createUser`, the single seam every method's user creation
passes through, with a `source` naming the action and the method; a returned
`{ error, errorDescription }` becomes a `403`. The gate rejects `create-user`
whenever `anyUserExists` finds a row and admits it otherwise, so a deployment
with no account is open and a deployment with one is closed to every method at
once, including methods added later. It never reads the identity or the method,
and that is what makes the second half true — do not add a per-method branch to
it. It admits `link-account` and `sign-in` untouched, so an existing member can
still link a provider and sign back in. The `errorDescription` reaches the
client, so it stays lean and names nothing about the deployment.

`CreateAuthOptions.userCreation` decides which instances carry the gate. It
defaults to `gated`, so a new instance is closed unless it says otherwise, and
only `bootstrap.ts`'s `signupAuth` sets `trusted`: invitation acceptance creates
a user precisely when accounts already exist, and `member.router.ts` has already
verified a specific pending, unexpired invitation before it calls. Never set
`trusted` on an instance mounted on the HTTP handler. The bootstrap CLI's
instance stays `gated` deliberately — it runs against an empty deployment, so
the gate admits it, and leaving it gated means the CLI is subject to the same
condition it checks for itself.

`anyUserExists` is not a repository method, and that is deliberate. It reads
better-auth's own `user` table, which carries no `organizationId`; a repository
method for it would be a second global-reach exception in a layer where
`organization.repository.ts`'s `listIds` is stated under Tenancy to be the only
one. It lives beside `createAuth`, next to the
`databaseHooks.session.create.before` hook that already reads a better-auth
table with no organization scope — the same standing exception `member.router.ts`
holds under Layering, for the same reason: better-auth's tables, reached from
better-auth's own wiring. Nothing in Tenancy is relaxed by it.

The first owner is created by a deployment-time bootstrap
(`pnpm --filter @open-mcc/server bootstrap:owner`, reading credentials from
environment variables), which refuses to run if any user already exists,
serialized with a Postgres advisory lock so two concurrent runs cannot both win.
That precondition and the gate ask `anyUserExists`, one predicate, so "is this
deployment uninitialized" has one meaning in one place. A first-run flow in the
dashboard must call `bootstrapOwner` rather than better-auth's sign-up endpoint,
and that is not a style preference: the gate reads before better-auth writes, so
two concurrent requests against an empty database would both pass it, and the
advisory lock is the only thing in this system that makes "exactly one first
owner" true. Every subsequent member arrives by invitation: an existing member
holding `member.manage` issues one, and the invited person's account is created
only as part of accepting that specific, still-pending invitation. Password
hashing is Argon2id, configured explicitly
(`apps/server/src/security/password.ts`) rather than left to better-auth's
default, because that default has changed between library versions and an
audit needs a fixed answer.

`createAuth` passes `ALLOWED_ORIGINS` through to better-auth's
`trustedOrigins` and sets `advanced.disableOriginCheck: false` explicitly.
Both halves are load-bearing. Without the first, better-auth trusts only
`BETTER_AUTH_URL` and answers the dashboard's own dev origin with
`403 INVALID_ORIGIN`, so `docker compose up` produced a server the dashboard
could not authenticate against. Without the second, better-auth's
`isTest()` branch defaults `skipOriginCheck` to `true`, which means the whole
server suite ran with origin checking switched off and could not have caught
the first problem — the suites that drive the HTTP stack all post from
`http://localhost:5173` against a `http://localhost:3000` base URL, and
turning the check on failed 21 tests until each of their `createAuth` calls
was given the same `trustedOrigins` production gets. A test suite configured
more permissively than the deployment proves nothing about the deployment;
`apps/server/src/auth-origin.test.ts` pins both halves.

Never add a `NOT NULL` column to a table better-auth owns unless better-auth
itself writes it. Migration 0005 made `account.issuer` `NOT NULL`; better-auth
1.7.2 never writes that column, so its startup schema check fails and **every
request returns 500**, auth included. Migration 0026 drops the constraint. The
failure is latent rather than immediate: it only appears once the image
installs the pinned tree, so a cached Docker layer can hide it for a long time
and a clean build will surface it without any code having changed.

### Removing a member

`member.remove` does not call better-auth's `removeMember`, and that is
deliberate. That endpoint counts owners and deletes in separate statements with
no lock, so two owners removing each other at once both pass and leave an
organization with no owner; and as a better-auth write it cannot share a
transaction with its audit row. `member.controller.ts` takes a per-organization
advisory lock, counts owners under it, and commits the delete, the cancellation
of every invitation the removed member still had pending, and the audit row
together. `member.controller.transaction.test.ts` drives the race.

- An owner cannot remove themselves. Another owner can, and the rule keeps an
  owner from locking themselves out by mistake.
- Under the lock the caller's own membership is read again, so an owner who was
  removed while their request waited is refused. That makes the owner count
  unreachable through two owners removing each other; it stays as the stated
  invariant. `acceptInvitation` likewise refuses an invitation whose inviter
  has no member row any more, which closes one better-auth inserted after the
  removal had cancelled the rest.
- After the transaction commits, better-auth's own `internalAdapter` deletes
  the person's account when no membership remains anywhere, so a later
  invitation creates a fresh one; otherwise it revokes their sessions whose
  active organization is this one. Never delete `user` or `session` rows here.
  A failure in that step is reported through the runtime error reporter and the
  removal still succeeds, because the request context already refuses the
  session.
- What the member authored stays. `host.hostKeyTrustedBy`,
  `instanceConfig.authorId` and `auditEvent.actorId` are nulled by their
  column-scoped `ON DELETE SET NULL`, and each row keeps its label.

## Adding a domain end to end

The `instance` domain is the reference, and it is real code rather than a
sketch — read the files as you go rather than trusting this summary, because a
summary drifts and the files do not.

1. `packages/contracts/src/instance.ts` — every zod schema and wire type for
   the domain, exported from `packages/contracts/src/index.ts`. Note what lives
   here and not in `core`: `DeviceCodeChallenge` is a contracts type even
   though only `core` produces it, because `apps/web` must be able to name the
   inferred router type and it does not depend on `core`. A return type that
   originates in `core` and reaches a router will fail the web app's typecheck.
2. A migration under `packages/db/migrations/` — `0009_instance.sql` for this
   domain. Every domain table carries `organizationId` with a plain FK to
   `organization` on delete cascade, and any FK to another domain table is
   **composite** on `(organizationId, id)`. That requires the referenced table
   to carry `UNIQUE (organizationId, id)`; `host` did not have one until
   `0009` added it, so check before assuming. Use the column-scoped
   `ON DELETE SET NULL ("authorId")` form for author columns, or member
   deletion fails outright on the NOT NULL `organizationId`. Then
   `DATABASE_URL=<test url> pnpm --filter @open-mcc/db db:migrate` followed by
   `db:codegen`, and add `packages/db/src/schema/instance.ts` narrowing the
   generated row the way `host.ts` does. **Register the narrowed table in
   `packages/db/src/database.ts`** — without that, `status` reaches every
   repository as a bare `string` and the narrowing does nothing.
3. `packages/core/src/instance/instance.repository.ts` — org-scoped throughout.
   Every method takes `OrgScope` first and filters on it. `update` writes
   `organizationId` into the `SET` clause last so a smuggled patch cannot move
   a row between organizations, and only whitelisted columns are updatable —
   claim columns stay out of that whitelist deliberately.
4. `packages/core/src/instance/instance.controller.ts` — capability check, then
   the work, then audit. The write and its audit row commit together through
   `withTransaction`, and **every SSH operation happens outside every
   transaction**. This project shipped a transaction spanning network I/O once;
   `host.controller.transaction.test.ts` exists because of it.
5. `apps/server/src/routers/instance.router.ts` — a `protectedProcedure` per
   method that does a `requireCapability` check and calls the controller.
   Nothing else. The router never touches `ctx.db`.
6. Map every new error class in `apps/server/src/errors.ts` and add its copy to
   `apps/web/src/lib/errors.ts`. Both are enforced: `errors.test.ts` derives
   the expected set from what the domain packages export, so an unmapped class
   fails rather than becoming a silent 500, and the web table is
   `Record<ErrorCode, string>`, so a code without copy fails typecheck.
7. Colocated `*.test.ts` beside each new file, including a cross-tenant case —
   organization A's actor must not read, modify or delete organization B's row.
   Tests that create rows clean up in `afterEach` with tracked ids, because
   `apps/server` runs its files sequentially and some assert a table is
   globally empty.

## Reusing SSH connections for reads

Every live readout used to open its own SSH login, so one open instance page cost
about 114 logins a minute. The server now shares one connection per host for
reads. The worker does not: its jobs run hourly or once per removal, so a cache
there would never be hit.

- **Readers only.** `createReadConnections`
  (`packages/transport/src/read-connections.ts`) hands out a `HostReader`, never a
  `HostTransport`. A reader can `exec` a `ReadCommand` with no stdin, `forward` and
  `release`, and nothing else. Every write stays on a fresh
  connection: start, stop, restart, create, send command, config save, sleep
  window, instance removal, inventory drop and select, scheduled commands,
  sign-in, host check, provisioning, teardown and the collector.
- **What the types do not prove.** `asReadCommand` accepts any string. What keeps
  a write off a shared connection is the allowlist test: only the reviewed read
  builders may name it, and `control.ts`, which holds `sendCommand`, is not one
  of them. `HostReader.forward` can post any MCP tool. The mitigation is the split
  in `live-control.ts`: the read side takes a `LiveReadTarget` and a
  `ReadToolName`, and both inventory writes take a `LiveControlTarget` built on a
  fresh `HostTransport`. Reviewing a change to either is the last line of defence.
- **Trust.** There is one entry per `organizationId:hostId`, holding the hostname,
  port, username, `sshKeyId` and fingerprint the connection was opened with.
  Re-trust and host removal call `evictHost` only after their transaction
  commits. Eviction bumps a generation, destroys every connection under the key,
  and refuses any connection still opening. After a lease is taken and before it
  is used, `leaseHostReader` (`packages/core/src/host/host-reader.ts`) re-reads
  the organization-scoped host row and gives the lease back if the row is gone,
  has teardown requested, or names a different identity. The health poller leases
  through it too, so it never connects on its fleet-list copy of a row.
- **Lifetime.** A connection ends with `end()` 10 seconds after its last lease,
  and with `destroy()` 2 minutes after it became ready, whatever leases remain.
  A lease reuses a connection only if its deadline ends before that hard age;
  otherwise a replacement opens and becomes the connection later reads use.
- **One deadline per read.** A read's deadline starts once the read has its
  connection, and covers the local queue, the channel open and every MCP phase:
  10 seconds for a live readout and the poller's username read, 15 for the
  console, server usage and host facts, 20 for a bot's journal, and 60 for the
  setup check. Opening a connection is bounded separately, by the 10-second
  connect timeout, so a read that has to open one can take its deadline plus up
  to 10 seconds: about 20 seconds for a live readout, and about 70 for the setup
  check. A deadline at or past the hard age is refused, and `reconcile.test.ts`
  keeps the setup check's below the hard age less a full connect.
- **Channels.** A connection allows 6 channels in total, counting execs and forwards
  together, and a forward holds its slot until it closes. A read that
  expires while it is still waiting in that local queue fails with
  `ChannelQueueExpiredError` and leaves the connection alone. A read whose
  deadline passes while a channel is requested from sshd or open retires the
  connection: it takes no new lease, and the next read opens a new one. The
  wrapper decides which happened from its own state, never from an error message.
- **Failures a readout swallows.** `TransportInterruptedError` is the base class
  for every way a shared read is cut short (queue expiry, deadline, a connection
  lost or evicted mid-read) and for a fresh transport's own timeouts. A readout
  returns nothing for it, as it does for `LiveChannelUnavailableError`. Anywhere
  else it maps to `HOST_NOT_ANSWERING`.
- **What a stalled client costs.** MCC runs each tool call on its main thread and
  waits for the result with no timeout. When a client's update loop stalls, every
  readout on its page hangs until its deadline, and each deadline retires the
  connection: about 6 logins a minute while that page stays open. The hung
  forwards also hold the connection's slots, so another bot's readouts on the
  same host can run up to one deadline late. If that starvation is ever seen, the
  fallback is a forward share per instance, not per kind of channel. It is not
  built.
- **No SSH inside a transaction** still holds. Leasing, reading and evicting all
  happen outside every transaction, and `host.controller.transaction.test.ts`
  watches both leasing and eviction for it.

## Live control

The control plane reads state from a running client over SSH. No MCC port is
reachable from any network, and nothing here may change that.

| Piece | File |
| --- | --- |
| `forwardOut` to the instance's loopback port | `packages/transport/src/ssh/connection.ts`, shared for reads by `packages/transport/src/read-connections.ts` |
| HTTP over that duplex, MCP handshake, bearer auth | `packages/core/src/instance/live-control.ts` |
| Wire parsing: SSE frames, JSON-RPC, MCC's `{success,data}` envelope | `packages/contracts/src/boundary/mcp.ts` |
| The rendered `[ChatBot.McpServer]` block | `packages/core/src/instance/config.ts` |

- Verify any claim about MCC against **the tag this repo deploys**, named in
  `packages/core/src/host/mcc-release.ts`, not against whatever a local
  checkout happens to have, by reading that tag explicitly. A local clone once
  sat 15 months behind and did not contain the live-control feature at all, so a
  round of "verified against the client" had been checked against a version
  that never had it. The instance console prints the running build, e.g.
  `GitHub build 511, built on 2026-08-29 from commit fbfae5b`.
- **The advanced-key editor is an AUDITED registry, not an escape hatch.** The
  59 keys an operator may set live in one Zod shape,
  `ADVANCED_KEY_SHAPE` in `packages/contracts/src/boundary/mcc-config-keys.ts`.
  Arbitrary keys, and keys MCC introduces later, are **refused by design** — the
  schema is `.strict()`, so an unregistered key is rejected at the write
  contract. A new key gets registered only after someone audits it: that it
  exists at the deployed tag, its C# scalar type, its enum members, and the
  table it renders under. Do not widen this to "any `ChatBot.*` key".
- **Bumping `MCC_VERSION` in `packages/core/src/host/mcc-release.ts` requires
  re-auditing every surface named in `docs/mcc-compat.md` and recording what you
  found there, or the build fails** — including all 59 registered keys — their existence, their scalar C# types,
  their enum members, their table shapes, **and the value ranges the client
  rewrites**. No test can catch a key that MCC RETYPES or RE-CLAMPS between
  releases: the registry would keep validating against the old form, render a
  value the new client rejects or silently rewrites, and nothing here would fail.
  The re-audit is the only thing that closes that gap.
- **A registered key must refuse any value the client would rewrite.** Each
  `ChatBot` module's `OnSettingUpdate()` clamps its own fields, and
  the clamped value is what the client runs with. Its write-back fails against the
  read-only `config/` mount, so the host file keeps the saved value and no drift
  check can see the clamp: an out-of-range value would run as something the
  saved settings do not say, and nothing would show it. 18 of the 59 keys carry
  such a bound; `ChatBot.AutoAttack.Cooldown_Time.Min`/`.Max` are swapped rather
  than clamped, so their order is checked across rows instead. This is the same
  rule `DELAY_SECONDS_MINIMUM` already follows for AntiAFK.
- **A dependency is a hint; a bound is a refusal.** The rule that an over-strict
  bound is a defect applies only to bounds, because only a bound rejects a value
  the client would have accepted. A dependency refuses nothing — it tells the
  operator that a setting will do nothing until something else is on — so the
  test for it is simply whether the thing genuinely stops working. That is why
  `ChatBot.AutoEat` gets a declared dependency on inventory handling even though
  the client never checks for it, while `ChatBot.AutoFishing.Detection_Warmup`
  gets none: it is read on every catch path, including the default positional
  one, so no condition is true of it.
- The three client-data settings (`TerrainAndMovements`, `InventoryHandling`,
  `EntityHandling`) are **not** part of live control and must never be presented
  as though they were. The client's own bots read them directly
  (`McClient.cs:1350/1358/1368`), and seven of the eight `ChatBot.*` bots do
  nothing without one. What keeps them from widening the MCP surface is the
  renderer, not the form: `config.ts` emits `Inventory` and `EntityWorld` as
  `liveControlEnabled && <setting>`, pinned by a test that turns both settings on
  with live control off and asserts both capabilities stay `false`.
- `operator` config drift means **a key we saved is no longer what the host
  holds**. It deliberately does NOT report a registered key the host sets but we
  never saved: MCC writes its own defaults for all 59 on first expansion, so
  that signal is indistinguishable from operator action without a per-version
  table of every default. A host value never reaches the browser for any key the
  operator owns, but that is no longer a guarantee of the type: an operator key
  can reach the public payload as `kind: "fixed"` — either because the value the
  host holds would expand to something unsafe on the client, or because the host
  DELETED the key and the client's own default carries the token, which is the
  "an absent key is not a safe key" case — and that member types `actual` as
  `string | null`. The guarantee is a runtime branch in `toPublicDrift`, which
  substitutes `WITHHELD_VALUE` for anything the host actually held and leaves
  `null` to mean genuinely absent. The same branch covers `SECRET_KEYS` —
  `Main.General.Account.Password` is allowlisted and rendered, so without it the
  host's password would be echoed verbatim.
- **Before registering any new key, ask whether the host's value for it could be
  a secret the control plane has no business republishing.** Password qualifies
  by construction: we only ever write `""` or `"-"`, so any non-empty host value
  is something we did not put there. `Main.General.Account.Login` deliberately
  does NOT qualify — it is an identifier the operator owns, already shown as
  `instancePublic.minecraftAccount`, and withholding it would cost real drift
  information. The live risk is additions, not the current set: `DiscordBridge`
  and `TelegramBridge` are pinned shut as `FIXED` keys, and each carries a
  `Token` field one line away in the same config table. Register either bot's
  other keys and that token becomes reachable.
- The channel is **read-only by capability**. `ChatAndCommands` and `Movement`
  are rendered `false` as `FIXED` keys, which is what keeps
  `mcc_run_internal_command` — MCC's entire internal command surface, `script`
  included — out of reach. Never enable those two to make a feature easier.
- **That capability pair is not the only door to the internal command surface.**
  Five of the client's own bots reach it too, each from a different trigger: a
  whisper from a listed bot owner (`ChatBot.RemoteControl`), a chat message
  matching a rule file (`ChatBot.AutoRespond`), a scheduled task's action string
  (`ChatBot.ScriptScheduler`), and a bridged message from either chat bridge
  (`ChatBot.DiscordBridge`, `ChatBot.TelegramBridge`). **All five are now pinned
  shut as `FIXED` keys** — the four bots by `Enabled = false`, and
  `RemoteControl` by rendering `Main.Advanced.BotOwners` as an EMPTY list,
  because the client's own default for that list is two guessable player names,
  and any of them could otherwise whisper the bot a command. With those pinned,
  the control FIFO and its allowlist are the only write path.
- **An absent key is not a safe key.** For the four `Enabled` flags, a host that
  drops the line falls back to `false` and stays shut. For `BotOwners` it falls
  back to the client's two default names, so ABSENCE IS THE VULNERABILITY —
  which is why it is rendered explicitly and why a host that deletes it reports
  `fixed` drift like any other tampering. Before pinning any future list, check
  which way its consumer reads an empty one: at least one list in this client
  treats empty as "allow everyone" rather than "allow nobody".
- `Inventory` and `EntityWorld` do grant mutation alongside the reads Stage 4
  wants, and the ratio is worse than it sounds: `Inventory` unlocks ten tools
  of which six write (`InventoryWindowAction`, `DropInventoryItem`,
  `OpenContainerAt`, `CloseContainer`, `ChangeHotbarSlot`, `SelectHotbarItem`,
  plus container deposit and withdraw), and `EntityWorld` brings `AttackEntity`,
  `InteractEntity` and `PickupItems`. Both default off, the settings UI states
  the cost per toggle, and the read-only summary names whichever are on so the
  grant is visible without opening the editor. `mcc_world_state` is gated by
  `SessionStatus` instead, so world data costs no write surface at all.
- `BindHost` is rendered as the literal `0.0.0.0` and is never an operator
  field. The client listens inside its own network namespace, and the unit
  publishes the row's port on the host's loopback alone
  (`-p 127.0.0.1:<port>:<port>`); a publish cannot reach a listener on the
  container's own loopback. A host file still saying `127.0.0.1` is `fixed`
  drift, and leaves the client unreachable, not exposed. MCC's own validation
  accepts `0.0.0.0`, `+` and `*` while rejecting `localhost` and `::1`.
- **The row owns the port.** `instance.liveControlPort` is a real column with a
  unique constraint per host. Anything that renders an instance's expected
  config takes the port from the row, never from the stored config document —
  `storedConfigFor` does that once, and both the start path (`expectedDocumentFor`,
  then `writeConfigDocument`) and `reconcileHost` render from it, so they cannot
  disagree. Four separate bugs came from reading a port out of a stale config;
  all four typechecked and passed tests.
- `create` probes the host with `canForward` before claiming a port, then
  retries on a unique violation. `canForward` answers "a forward succeeded",
  which means something holds the port: a listener, or Podman's forwarder for a
  running bot whether or not its client listens. For allocation that is the
  behaviour wanted.
- The token is minted fresh on **every start**, sealed in the store, and reaches
  MCC only through `podman run --env-file`, from the instance's `env` file: one
  unquoted `MCC_MCP_AUTH_TOKEN=<32 lowercase hex>` line, because Podman keeps
  quotes as part of the value. It must never enter `MinecraftClient.ini`, which
  drift reads back.
- The config is mounted read-only at `/config`, so the client's write-back on
  load and on clean exit fails and is logged. `start` re-renders the saved
  config immediately before launching the unit, so a save made while an
  instance runs takes effect at its next start.
- MCP listens only between `AfterGameJoined` and disconnect, so a readout that
  finds nothing before the client joins means "not joined yet", never failure.
  Podman's forwarder holds the published port whether or not the client
  listens, so a forward that succeeds proves nothing. A live endpoint that never
  answered *after* joining is reported as `unreachable` drift, because MCC
  swallows its own bind failure: reconcile posts once to the route without the
  token, and only a `401` proves the client listens.

## What the bots write on a host

Three of the client's bots write files the console does not carry, so turning
them off would lose the feature rather than duplicate it.
`packages/core/src/instance/artifact.ts` reaches a host over the same SSH
transport reconciliation uses and takes those files back, and
`artifact-collect.job.ts` runs it hourly from the worker on
`INSTANCE_ARTIFACT_QUEUE`. Each writer is handled by what the file *is*, not by
what it is called:

- `ChatBot.PlayerListLogger.File` is append-only text in the bot's `state/`,
  and the collector never writes into it while either of the bot's units runs.
  Each instance row keeps a cursor: `playerListOffset`, `playerListFingerprint`
  (the sha256 of the up-to-64 bytes before the offset, `EMPTY_FINGERPRINT` at
  0) and `playerListCursorVersion`. One exec per sweep prints the file's size
  (a regular file only), the `ActiveState` of both units, the fingerprint before
  the stored offset, the next chunk of up to `MAX_ARTIFACT_BYTES`, and the
  fingerprint where that chunk ends. `storeAndAdvance` inserts the chunk and
  moves the offset by the bytes actually received in one transaction, as a
  compare-and-set on the version, so a commit read before any other cursor
  change matches no row and its artifact rolls back. A chunk shorter than the
  exec announced is not stored. A size below the offset, or a fingerprint that
  no longer matches (a truncate and regrow in the same file), resets the cursor
  to 0, and the same sweep reads again. Once both units are `inactive` or
  `failed` and the whole file is stored, one exec empties it under
  `collect.lock` and `withDeadline(2, 10, …)`, re-checking both units, the size
  and the fingerprint inside the lock; the cursor then resets. It takes that
  lock on a descriptor of a file that must already exist, so it can never
  create one, and a bot whose `collect.lock` has gone stops truncating until
  its next start remakes it — the sweep counts it `failed` and the hourly
  report names it, which is the only signal an operator gets. The unit's
  `ExecStartPre` takes the same lock, so a start cannot pass it while the
  truncate runs, and a start that passed first is `activating`. Every SSH step
  stays outside the transaction: read, then commit, then truncate.
- `ChatBot.ReplayCapture` writes finished `.mcpr` archives to
  `replay_recordings/`, mounted from the instance's `replays/`, and a raw
  packet stream to `recording_cache/<run>/recording.tmcpr`, mounted from
  `recording-cache/`. The archives are listed as regular files only, read with
  `dd iflag=nofollow,nonblock`, collected whole and deleted; a prefix of a ZIP
  is worthless, so one over `MAX_ARTIFACT_BYTES` is left alone, counted as
  oversize, and removed by age after `REPLAY_KEEP_DAYS` — the host stops
  growing either way, and the drop is reported rather than silent. The cache is
  **never** collected, and the sweep does not touch it: it is scratch that the
  client deletes on a clean shutdown and leaks on every hard kill, and the
  unit's `ExecStartPre` empties it under `collect.lock` before a container
  exists to race it. That is also why the delete stays in the start phase rather
  than moving somewhere it could not block a start: a start is the one moment at
  which no container can be writing a recording into it, and the only event
  guaranteed to come before the client opens the cache again. Moving it into the
  hourly sweep would put an `rm -rf` against a live recording; moving it to
  `ExecStopPost` would skip it on a host that lost power.
- **A `.mcpr` that looks finished may still be being written, and taking it
  destroys it.** `ReplayHandler.WriteReplayArchiveUnsafe` opens the FINAL path
  with `FileMode.Create` and streams the whole raw recording through Deflate
  into it — there is no temp-then-rename, so a partial archive sits at its
  final name for the entire write. Collecting one stores bytes that are
  unreadable by construction, because a ZIP's central directory is written last;
  worse, the `rm` that follows unlinks a file whose `FileStream` MCC still
  holds, so the client finishes writing into an inode with no name and the
  operator is left with a recording that reported success and does not exist.
  So an archive is collectable only once its own mtime has been still for
  `REPLAY_SETTLE_MINUTES`, which `find -mmin` applies on the host to the
  archive's own mtime. That is enough
  on its own because `GetReplayDefaultName()` stamps a UTC millisecond, the pid
  and a random token into every name, so a path is never written twice and the
  only race is with the write in flight. **The margin is not derivable from MCC
  source**: how long the write takes is a function of the recording's size and
  Deflate's throughput, and nothing bounds either. Fifteen minutes is a choice,
  anchored at three times the 300-second default of
  `ChatBot.ReplayCapture.Backup_Interval` — the only duration the feature's own
  source offers, being the cadence `Update()` assumes a full archive write fits
  inside. It errs large deliberately: too large costs one hourly sweep of
  latency, too small destroys a recording.
- A prune is counted only when the host actually deleted something. `find`
  evaluates predicates left to right and `-delete` is false when removal fails,
  so the order is `-delete -print`; written `-print -delete` the name is
  printed first and a deletion the host refused is still counted.
- **`ChatBot.Mailer`'s `DatabaseFile` and `IgnoreListFile` cannot be collected
  at all, and the sweep only measures them.** They are bot state rather than
  output: `Initialize()` reads both into memory and a `FileMonitor` re-reads
  both on any external change, so truncating the database does not free space —
  the bot reloads an empty one and every undelivered mail is destroyed, and
  emptying the ignore list un-ignores everyone. Neither file is appended to;
  `SaveToFile` rewrites the whole collection, so there is no tail to drain and a
  partial read is a torn read. The content is also third-party private
  correspondence, which the control plane has no business republishing. Growth
  is already bounded by the client itself — `Update()` drops delivered and
  expired mail every ten seconds, and writes are refused past
  `MaxDatabaseSize` and `MaxMailsPerPlayer`. What is missing is an upper bound
  on those two registered keys, which admit up to `INT32.max`; until one exists
  the sweep reports the byte size and warns past `MAILER_STATE_WARN_BYTES`, so
  the growth is visible rather than silent.

The sweep re-reads the host before each bot, and again before that bot's
truncate, replays and Mailer, and stops touching a host once its removal is
requested (`artifact-collect.job.test.ts`). One exec already under way can still
land inside teardown's delete, but no collector command creates an entry inside
a bot's directory, so a sweep makes neither a removal's `rm -rf` nor teardown's
fail.

A file on a host is attacker-influenced — a player's chat reaches
`PlayerListLogger` through the tab list and `Mailer` through a private message —
so **the collector never interprets what it carries**. Content is validated as
base64 and nothing else, decoded straight into a `Buffer`, and stored as
`bytea`; it never becomes a string, never reaches a log, and never appears in
the sweep result. Every other remote-derived value is refused unless it matches
a closed shape: a replay file name must be `[A-Za-z0-9_]+.mcpr`, an operator's
configured file name must be a bare name with no separator and no `%` the
client would expand, and a count must be digits alone. A name that fails is
counted as refused and left where it is — the sweep would rather collect
nothing than delete a path it did not configure. `InstanceArtifactSweep` and
`ArtifactCollectRun` carry numbers and ids this side owns, so no transport
error text can ride out of the sweep; per-file transport failures are caught
and counted rather than propagated, and only a failure to reach the host at all
goes to the logger, through the redactor the health poller already uses.

What the control plane holds is bounded twice, because retention alone does not
bound a busy fleet: `ARTIFACTS_KEPT_PER_KIND` newest rows per instance per
kind, each at most `MAX_ARTIFACT_BYTES`, and everything past
`ARTIFACT_RETENTION_DAYS` regardless. An unreachable host costs nothing — it is
counted, skipped, and retried on the next hour, which is why the queue's
`retryLimit` is `0` — and retention still runs for its organization.

## Removing a bot or a host

Removal's container and directory deletes, teardown's container, image and
directory deletes, and the collector's check-and-truncate each run under a
deadline on the host. `withDeadline` (`packages/core/src/host/deadline.ts`)
renders `timeout -k <k> <n> <command>; s=$?; exit $s`, with `n + k` below the
wait the manager gives that exec. The outer shell stays, so a TERM or KILL
arrives as exit 124 or 137, which `endedByDeadline` reads. A process in
uninterruptible sleep can outlive both signals.

- **A bot's row goes only once the host shows it gone.** `remove` deletes the
  sleep timers, stops both units, removes both containers, verifies that neither
  unit runs and neither container exists, deletes the bot's directory, and
  verifies again. A failed container removal or verify, or a delete ended by its
  deadline, is `InstanceStillInUseError`; a failed timer step or any other
  failed delete is `InstanceRemovalFailedError`. Both keep the row. The delete
  makes anything the bot locked writable first, and `rm -rf` follows no link.
  Every step runs under the bot's config claim, and the row is deleted with
  `deleteUnderClaim` only after the second verify, so the row outlives the host
  tree until that tree is provably gone.
- **Teardown runs on `HOST_TEARDOWN_QUEUE` with `retryLimit: 2` and
  `retryDelay: 60`**, longer than its longest host deadline of 55 seconds, so a
  retry starts only after the last attempt's deadlines have ended. It stops
  every bot and sign-in by unit pattern, removes the containers
  `MANAGED_CONTAINER_PATTERN` matches, both pinned runtime images and the
  instances directory, and leaves lingering on, since turning it off cannot be
  relied on without root. The host row is deleted only when nothing is left.

## Checking for a newer release

The worker asks GitHub for the source repository's latest release four times a
day, on `SYSTEM_UPDATE_CHECK_QUEUE` at `41 */6 * * *`, and records the answer in
the one `updateState` row. A development build never asks. A page load never
reaches GitHub; it reads that row.

- **The version is the answer; the notes are decoration.** Nothing about the
  notes may stop a version being recorded. GitHub allows a release body of about
  125,000 characters, up to ~488 KiB of UTF-8 before the rest of the JSON is
  counted, so the request reads up to `RELEASE_RESPONSE_MAX_BYTES` (1 MiB) and
  fails closed past it: undici errors rather than truncates, and no legitimate
  release reaches that size. The notes are then cut to `RELEASE_NOTES_MAX_BYTES`
  (64 KiB) with `truncateBytes` and flagged, never refused. `sendPinned` keeps
  the 64 KiB notification limit as its default; the larger cap is per caller.
- **The URL is assembled, never accepted.** Owner and repository are separate
  values matched against `sourceOwnerSchema` and `sourceRepoSchema` at the moment
  of use, neither can hold a character that ends a path segment, and the host is
  a constant. The request still goes through `sendPinned` under `PUBLIC_ONLY`,
  and redirects are not followed: a renamed repository answers `301`, which is
  recorded as `not-found` rather than handing the destination back to the remote.
- **Nothing GitHub sends is kept as text except the notes.** The outcome is a
  closed union, and a rate limit keeps only the time it ends. No status text,
  header or URL from the answer is stored, logged or shown.
- **The queue never retries** (`retryLimit: 0`). GitHub allows 60
  unauthenticated requests an hour per address, and a retry into a rate limit
  is what makes it worse. A failed check waits for the next poll.
- **A starting worker checks only when the last check is older than the poll.**
  It sends through `sendJob`, which is why this queue is in `QUEUE_NAMES` while
  the schedule-only artifact queue is not. Boots that crash before any check
  lands can each still queue one, and two workers starting together send two,
  so the job itself asks nothing when the recorded check is younger than half
  the poll: duplicates drain without a request, and the six-hourly schedule,
  whose last check is always older than that, is untouched.
- **Release notes never become HTML.** `parseReleaseNotes` reads them into a
  closed set of blocks — heading, paragraph, bullet, numbered item, code — and
  the dashboard renders those as React elements, so text is escaped by
  construction. Anything outside that set stays literal text, `<script>`
  included. A link keeps its label and address as text and never gains an
  `href`: the one live link is the release page, built from the validated source
  and version, never from anything GitHub sent. The model stops at 500 blocks
  and 2,000 characters a block, and the page shows 12 before **Show all**, so a
  long note cannot freeze the browser.
- **The badge polls a small answer; the notes come only when asked.**
  `system.updateStatus` carries versions, times and the outcome, and is read
  every minute. `system.releaseNotes` is read only while the update is open.
- **The update opens from the layout root, never from inside the sidebar.** The
  `<aside>` always carries a translate, and any `translate` other than `none`
  makes an element the containing block for its `fixed` descendants, so a
  `Modal` mounted in it is sized to the 240px sidebar. `BuildBadge` only asks
  `_authenticated.tsx` to open it, beside `CommandPalette`.
- **`/releases/latest` reads GitHub Releases, not tags.** `release.yml` publishes
  images for a `v*.*.*` tag but creates no Release, so the check records
  `not-found` until a Release is published for that tag.

## Logging

Each daemon owns exactly one root logger, at module scope in its own
`src/root-logger.ts`, built from `readLevel(process.env.LOG_LEVEL)` **before**
`loadEnv()` — so a rejected environment is itself reported through it, and so
the fatal `main().catch(...)` handler, which lives outside `main`, logs through
the same root. The entrypoint hands that root to `startServer`/`startWorker`
explicitly; the parameter is required and has no default, because a default
would conceal the dependency while still letting a caller pass something else.

No bare `console.*` in `apps/server/src` or `apps/worker/src`. The three
operator-facing CLI paths are the only exceptions — `bootstrap-owner.ts`,
`bootstrap-owner-cli.ts` and `generate-sealbox-key-cli.ts` — because a person at
a terminal should not be handed JSON.
`packages/core/src/log/daemon-console.test.ts` asserts that exact set by file, so
a new `console.error`, `console?.error` or `console["error"]` in either daemon
fails the suite. It matches named console methods rather than any `console.`
text, because `"console.read"` and `"console.write"` are capability names in
`instance.router.ts` and are not console calls.

**A pg-boss `warning` payload is never logged.** Both apps register the one
shared `attachQueueWarning` adapter, before `boss.start()` because warnings fire
during startup, and each app's complete `warning` listener set must be exactly
that adapter — a second listener beside a safe one is the hole this closes. The
adapter logs `warning.message` and nothing else: the event type is
`{ message, data }` with no discriminator, and `data` carries bound query
parameters, so message-only is forced rather than preferred.

What error text may contain, stated rather than assumed: **addresses and ports
may appear** in redacted error text. `redact()` has no hostname, IP or port
pattern, and a self-hoster's own database host in their own diagnostics is the
same category as the server address they typed into the settings form. Known
credential syntaxes continue through the redactor, which masks a
`SEALBOX_KEYS=...` assignment and not a bare key value.

**The redactor's pattern table is split across two packages on purpose.**
`packages/contracts/src/command-credentials.ts` owns
`UNAMBIGUOUS_SECRET_PATTERNS`, the thirteen whose marker is literal — a PEM
armour line, `SEALBOX_KEYS=`, `whsec_`, `re_`, `X-Gotify-Key`,
`Authorization: Bearer`, a URL query's `sig`, and the six webhook hosts.
`packages/core/src/security/redact.ts` owns `LOG_ONLY_PATTERNS`, the five whose
marker is only a shape: a bare `Bearer <token>`, `AUTH PLAIN <token>`, a bare
Telegram bot token, the `AAAA-BBBB` device code, and a URL query's `sv` or `sp`.
Three of those five are known to match ordinary Minecraft chat — `/team join
BLUE-TEAM`, `/say bearer of bad news` and a YouTube link's `&sp=` filter all do;
the bare Telegram token has no measured false positive and is held back on the
rule rather than on evidence, because admitting one shape-only pattern makes the
split a judgement per pattern instead of a rule. A Recent chip that silently
disappears is a defect where a mangled audit detail is only cosmetic.

`redact` applies all eighteen, in the order `REDACTION_PATTERNS` lists them, and
that order is load-bearing rather than incidental: the device-code pattern runs
after `Bearer` and before `SEALBOX_KEYS=`, `SEALBOX_KEYS=` runs before `whsec_`,
and moving any of them changes what the later pattern can still see. Two of the
eighteen are deliberate no-ops there, subsumed by a broader sibling that runs
first — `Authorization: Bearer` under the bare `Bearer`, and `sig` alongside
`sv`/`sp` — and that is what lets the browser have the narrow half without the
server losing the wide one. Do not merge the two lists into one, do not reorder
`REDACTION_PATTERNS` to group them, and do not give the browser the five.

**Every pattern in `command-credentials.ts` is parsed by a browser** — the whole
module evaluates there, not the one list `command-history.ts` imports from, so
`COMMAND_PATTERNS` is as exposed as `UNAMBIGUOUS_SECRET_PATTERNS` — and both are
limited to syntax the oldest engine this dashboard loads in accepts. `redact.ts`'s
own `LOG_ONLY_PATTERNS` are not: `apps/web` has no runtime dependency on
`@open-mcc/core`, so they never reach a browser. A
lookbehind (`(?<=`, `(?<!`) is not: `apps/web` sets no `build.target` and no
browserslist, so Vite's esbuild default includes safari14, esbuild lowers a
lookbehind literal to a `new RegExp(...)` call, and that call throws
`SyntaxError` at module evaluation on Safari before 16.4 — blanking the whole
authenticated dashboard, not just the Recent list, because the module is
statically imported by the `_authenticated` layout. `resendKey` uses a consumed
leading group (`(^|[^A-Za-z0-9_-])`) rather than a lookbehind for exactly this
reason. Narrowing `build.target` instead is not the fix: what this project
supports is the owner's decision and is written down nowhere yet.

That allowance is for logs alone. **A failure stored in a column or returned to
the browser carries only this project's own fixed words**, never text a host,
the SSH transport, the client, a Minecraft server or a notification provider
produced. Map at the point the failure is recorded, not where it is thrown:
`host.controller.ts` records the fixed copy for the step provisioning reached
(`provision-failure.ts`); the teardown job, the scheduler and the notification
delivery job (`delivery.job.ts`, with fixed provider wording in `outcome.ts`) do
the same; and each hands the raw error or provider text to its redacted
`onError` reporter. A bot's disconnect reason is not stored at all. A rewrite of
the steps behind those boundaries then cannot reopen the leak.

The one exception is what a host reports about itself: its OS name and id, its
systemd release line, and the machine name the architecture check repeats when
it refuses. Those reach a column or the browser only through `hostFact` in
`facts.ts`, which passes printable ASCII of at most 128 characters and turns
anything else into `Unknown`.

Every deployment path that runs a daemon must forward `LOG_LEVEL` and
`OTEL_EXPORTER_OTLP_ENDPOINT`. Compose passes only the variables it lists —
there is no `env_file:` — so an unforwarded variable makes correct code ship a
feature that silently does nothing. `scripts/compose-secrets.test.ts` pins both,
per service.

## Dashboard (apps/web)

- Any UI that establishes or re-establishes trust in a host key (enrolment,
  `retrustHostKey`, and anything similar added later) takes the fingerprint
  as operator input obtained out of band. It never fetches, displays, or
  offers to detect the host's presented key. Showing the presented value
  would let an operator submit a dummy fingerprint, read the real one back
  from the failure, and paste it in on a second try, which collapses
  out-of-band verification into two-request trust-on-first-use — exactly
  what the server side spent a security round closing.
- Error copy for these trust failures comes from a static table keyed on the
  response's `errorCode` (see `apps/web/src/lib/errors.ts`). The defence is
  two layers and both are real. Server side, `host.controller.ts` strips the
  presented and expected fingerprints from `FingerprintMismatchError` and
  `trpc.ts` replaces the message of anything `mapKnownError` does not
  recognise, so a domain error's own text never reaches the client. Client
  side, `packages/contracts/src/errors.ts` owns the wire error codes and
  `ERROR_MESSAGES` is typed `Record<ErrorCode, string>`, so adding a code the
  server can send without adding operator-facing copy for it fails
  `pnpm typecheck` — a new trust error cannot quietly fall through to the
  server's own words. The server half is covered too: `errors.test.ts` reads
  the error classes off what `@open-mcc/core` and `apps/server/src/errors.ts`
  export rather than listing them, so a new domain error class with no case in
  `mapKnownError` fails the suite instead of reaching the dashboard as an
  unmapped 500.
- `getErrorMessage` does still fall back to `error.message` when the response
  carries no recognised `errorCode`, and that tail is deliberate rather than a
  gap in the above: what reaches it is a zod validation message, which is
  derived from the schema and not from server state, or a fixed constant like
  `Internal server error`. Never widen it. Anything that could carry server
  state must arrive with an `errorCode`, which is what forces copy for it.
  The zod message is one sentence, never the issue list: `trpc.ts` sends the
  first message a contract wrote, or a fixed sentence when every issue carries
  zod's own wording. Only an input failure gets that treatment; a zod error
  raised inside a procedure is a server fault and gets the generic message.
  `getErrorMessage` refuses a message that is a stringified structure all the
  same.
- Design tokens are pinned by
  `apps/web/src/index.css.test.ts`, which parses `index.css` and compares
  every custom property it declares, as `scope name: value`, against one
  expected list. Deleting a declaration, changing a value, or moving one
  between the light and dark blocks all fail that test. It was previously a
  set of `toContain` checks on bare token names, which a `var()` reference
  elsewhere in the file satisfied and which prefix collision let
  `--error-foreground` satisfy on behalf of `--error`; both `--error:`
  declarations could be deleted outright with the suite still green. Do not
  go back to substring matching. Reuse existing token families; never invent
  one locally.
- That pin covers custom property declarations and nothing else, and the gap
  is not theoretical. `index.css`'s `@layer base` carries
  `* { @apply border-border outline-ring/50; }`, and it was missing from this
  repository until the shadcn components started using a bare `border`.
  Nothing caught it: the
  rule declares no custom property, so the pin test cannot see it, and no
  component had yet written a bare `border`. Tailwind v4's preflight is
  `border: 0 solid`, so the moment `card.tsx` and `button.tsx` did, every
  bordered element drew its border in `currentColor` — the text colour.
  "Design tokens are mirrored and pinned" was true the whole time; "the
  stylesheet is correct" was not, and the difference between those two
  sentences is exactly where the divergence lived. The guard over this file is
  custom-property-only — `index.css.test.ts` ignores any declaration whose name
  does not start with `--` — so no base-layer rule, component class or
  `@utility` block is covered by it. Do not build a second guard for it. This
  is a named limitation to check by eye, and `@layer base` is where a rule can
  go missing without any test noticing.
- `dropdown-glass` and `surface-glass` in `index.css` each end with an
  `@supports not (...)` block whose `background` carries `!important`, and
  `biome.json` turns `complexity/noImportantStyles` off for that exact path,
  widening the override that file already had rather than opening a new one.
  Both halves are deliberate rather than legacy. The obvious cleanup —
  invert each rule so the opaque background is the base and the translucent
  one moves inside `@supports (backdrop-filter: blur(1px))`, which needs
  neither `!important` nor an exemption — does not survive the build.
  Lightning CSS splits the rule and hoists the `color-mix()` background into
  its own `@supports (color: color-mix(in lab, red, red))` block, which sits
  outside the backdrop-filter guard; a browser with `color-mix` but no
  `backdrop-filter` then paints the translucent surface with nothing
  blurring behind it, and the select popup is unreadable over page content.
  Every browser a developer is likely to test in supports both, so the
  inversion renders identically on the machine that writes it and ships the
  bug everywhere else. Do not invert these rules and do not drop the
  exemption. `index.css.glass.test.ts` fails if you do — it pins the shape,
  not the rendering, because a source test cannot see what Lightning CSS
  emits. So if you change these rules for any other reason, still read the
  built CSS under `apps/web/dist/assets/` rather than the source; the bug
  above was found by reading the build output, not by reasoning about the
  stylesheet.
- A property can move between the stylesheet and a component, so changing one
  without the other silently duplicates or drops it. `dropdown-glass` once
  carried its `box-shadow` in `index.css` while the popup element in
  `select.tsx` also set `shadow-[...]` classes, which would have applied both.
  Nothing catches this, because the value crosses the boundary the token guard
  watches — it is neither a changed declaration nor a changed class, but the
  same property arriving from a different file. When you move a visual property
  out of one, check the other.
- `text-muted-foreground` is the single source for placeholder text, secondary
  labels and muted icons. Do not introduce `--placeholder`, `--secondary-label`
  or `--icon-muted` as separate tokens: they would each resolve to
  `var(--muted-foreground)` at every setting this dashboard ships, so they add
  a layer that changes nothing until an appearance control exists to move them,
  and this dashboard has none.
- `CardTitle` renders a `div` rather than a heading, and that is a considered
  exception rather than an oversight. It is a
  real accessibility loss for screen reader users navigating by heading;
  every dashboard page carries its own `<h1>`, so no page is heading-less,
  but the card titles under it are not in the outline. Forcing an `h2` needs
  `render={<h2 />}`, which biome's `a11y/useHeadingContent` rejects because
  that element has no children of its own — they are merged in at runtime —
  so the only route is an exact-path lint exemption that would suppress a true
  finding. Do not add one. Giving card titles heading semantics is a product
  decision about this dashboard, and nobody has made it.
- `apps/web/src/routeTree.gen.ts` is generated by TanStack Router and is
  exempt from the type-policy checker by its exact path, not by filename —
  see What enforces what above. A same-named file placed elsewhere is not
  exempt and must not be made so.
- The console history is the one thing this dashboard writes to `localStorage`
  that an operator typed. A command any pattern in `maskCommandCredentials` or
  `maskUnambiguousSecrets` would change is not stored at all rather than stored
  masked, because a masked entry invites a click that silently fails, and
  `readCommandHistory` drops any such entry an earlier visit left behind and
  writes the shortened list back. The purge is not left to that read alone:
  `command-history.ts` sweeps **every** `open-mcc:command-history:` key as the
  module loads, and `_authenticated.tsx` imports it, so the sweep runs when the
  authenticated shell first renders — on any page, not on the first console
  opened. Theme and view mode are the only other keys this dashboard stores and
  neither the sweep nor the clear touches them. Every read and write stays inside
  a `try`/`catch` — `localStorage` throws in a private window and with site data
  blocked — and a new key holding what an operator typed belongs in both the
  sweep and the clear.
- **Every path that signs out clears those keys, and there are three of them**:
  the shell's sidebar button, the command palette's "Sign out" action, and the
  `SignedInNotice` an invited person meets when the machine is already signed in
  as somebody else. That last one is the sharpest case — it exists precisely to
  hand the machine to a different person. Each calls `clearCommandHistories()`
  **before** it calls `authClient.signOut`, never after, so a refused or
  unreachable sign-out still empties the history. A fourth call site must do the
  same; `apps/web/src/components/sign-out.test.tsx` compares the set of files
  naming `authClient.signOut` against an exact list, so adding one fails until
  it is reviewed.

## Tests

Colocated `*.test.ts`. Tests that touch real Postgres need
`TEST_DATABASE_URL` pointed at a running server — `docker compose -f
docker/compose.yml up -d postgres-test` starts one on `localhost:55432`
with the default `postgres` database (see `.env.example`), which is what
`TEST_DATABASE_URL=postgres://postgres:postgres@localhost:55432/postgres`
in that file resolves to. That database has no volume and is not expected
to survive a restart, so it comes up empty and needs the schema applied
before the suite will run:

```bash
DATABASE_URL=postgres://postgres:postgres@localhost:55432/postgres \
  pnpm --filter @open-mcc/db db:migrate
```

Note the variable: `db:migrate` reads `DATABASE_URL`, not
`TEST_DATABASE_URL`, so migrating the test database means overriding it for
that command alone. Skip this and the suite fails with `relation
"organization" does not exist`, which names nothing that would lead you here.

`TEST_DATABASE_URL` does not have to be exported. `packages/config/load-env.mjs`
loads the repository's `.env` through `process.loadEnvFile`, and
`packages/db`, `packages/core` and `apps/server` each run it as a vitest
`setupFiles` entry; `packages/db/src/migrate.ts` imports it too. An exported
variable always wins over the file, because that is `loadEnvFile`'s own
precedence, so CI — which sets `TEST_DATABASE_URL` in the workflow and has no
`.env` — behaves exactly as it did before, and a one-off override on the
command line still works. `.env` is listed in `turbo.json`'s
`globalDependencies` so editing it invalidates the test cache; without that
line turbo would replay a cached pass against a database you had just
repointed. A new workspace whose tests need a database must add the same
`setupFiles` entry — nothing loads it globally. `scripts/load-env.test.ts`
copies the loader into a throwaway repository layout and proves all three
behaviours (loads, does not override, inert with no `.env`) without touching
your real one.

Do not try to save that step by mounting `packages/db/migrations` into the
container's `/docker-entrypoint-initdb.d`. It was tried and measured: the
schema applies, but Postgres pipes the files straight through psql and no
`kysely_migration` table is written, so the migrator sees a database with no
history, replays from `0000`, and fails with duplicate_table (42P07) on the
first `CREATE TABLE`. The mount and `db:migrate` are mutually exclusive, and
`db:migrate` is the one the suite depends on.

The suite creates and tears down every row it needs. Tests track the ids they
create and delete only those — no blanket deletes — so row counts are
unchanged across a full run.

Cleanup runs on the failure path, never as the last statement of an `it` body.
A failing `expect` above such a call skips it, and the rows it would have
deleted stay in the database, so the next run fails on state the change in
front of you did not create. Four suites were written that way; one
deliberately broken projection leaked a tenant and cost a diagnosis cycle
chasing failures in two files that had nothing to do with it.

`apps/server/src/retrust.test.ts` is the shape to copy: the sign-up helper
pushes each organization id and each email onto a module-level array as it
creates them, and one `afterEach` deletes what is on those arrays. Prefer that
to a `try`/`finally` around the test body, because a `finally` covers only
what its `try` encloses, and the setup that creates the rows usually sits on
the line above it — `apps/server/src/ssh-key.test.ts` and
`apps/server/src/organization-creation.test.ts` both call `signUpOwner()`
outside the `try`, so a helper that creates the user and then fails its own
`expect` on the next request leaks that user. Those two are the narrower form
of the same defect and are not converted yet.

No test may require a table in the shared database to be globally empty.
Nothing orders the workspace test tasks against each other — `turbo run test
--dry` shows `@open-mcc/core#test`, `@open-mcc/db#test` and
`@open-mcc/server#test` each depending on `^build` alone, and turbo's default
concurrency is 10 — so all three run at once against the same
`TEST_DATABASE_URL`, and both `packages/core/src/test/db.ts` and
`packages/db/src/schema/tenant-fk.test.ts` insert `user` rows. A
globally-empty assertion is a coin flip against those, decided by timing and
blamed on whatever change is in flight when it loses.

`bootstrapOwner` refuses to run when any user exists, so the suite covering it
genuinely needs an empty `user` table and cannot scope its way out.
`apps/server/src/bootstrap-owner.test.ts` creates its own database in
`beforeAll` — `create database`, then `migrateToLatest` from `@open-mcc/db` —
and drops it in `afterAll`, the pattern `packages/db/src/migrator.test.ts`
already uses. The advisory lock `bootstrapOwner` takes is scoped to one
database, so that is isolated with it. Resetting every table between tests is
allowed inside a database a suite owns outright, and only there: it is the one
exception to no blanket deletes, and it is safer than tracking ids, because it
cannot miss what a half-finished test left behind. A killed test process
leaves such a database behind undropped; it is inert, but drop it by hand
rather than wondering what it is.

`apps/server` still runs its test files one at a time
(`apps/server/vitest.config.ts`, `fileParallelism: false`), because every file
there drives the real auth stack and opens its own connection pool against one
Postgres instance. It is not what makes any assertion correct, and nothing may
be written that leans on it: it orders files within `@open-mcc/server` and has
no effect whatever on the other workspaces hitting the same database at the
same moment.

Failure-mode suites (wrong role, expired or
already-used invitation, a terminated connection, a concurrent claim) are
mandatory, not optional — a control with no test proving its failure path
is not a verified control.

### The script sandbox

Three scripts change a real machine: `scripts/install.sh`, `scripts/self-host.sh`,
and the setup script `apps/web/src/lib/host-setup.ts` generates for an operator
to paste. `pnpm test:sandbox` runs each of them for real and asserts on what
they did to the machine, never on their text.

The host is `docker/sandbox/`: Debian with systemd as PID 1, sshd with host keys
minted at boot, and a sudo-capable `tester` account. It starts `--privileged
--cgroupns=private` with tmpfs on `/run`. The installer runs inside `docker:dind`
on a copy of the checkout, never the checkout itself, because it writes `.env`.

The Dockerfile's `podman-host` target adds rootless Podman to that host, built on
the `BASE_IMAGE` argument: `scripts/sandbox/podman-host.sandbox.ts` runs it on
Debian 12, Debian 13 and Ubuntu 24.04. It masks Podman's own system units, which
fail in a container and leave the host `degraded`. Its accounts `pod1` to `pod6`
each get a `--tmpfs` over `~/.local/share/containers`, because rootless overlay
cannot nest on Docker's overlayfs. `scripts/sandbox/provision.sandbox.ts` provisions
`pod1` on each target through `provisionHost`, and `scripts/sandbox/runtime.sandbox.ts`
drives a bot through the instance controller: create, start, the console, a
scheduled command, restart, a sleep window, a stop, both missing-settings
refusals, a start refused while sign-in runs, a start on a settings file put in
place by a rename, and a settings write cut short, which leaves the previous
file and no temporary. Its client is a stand-in script inside the pinned
runtime image, because a real client exits when it has no server to join.
`scripts/sandbox/sign-in.sandbox.ts` runs the real client in the sign-in unit only
after it has cut the host off every network and seen an HTTPS attempt to
Microsoft's sign-in host fail, so no device code is ever requested: the client
logs a network error and the unit ends with status 4. With a stand-in client that
waits, it proves a sleep window's start is skipped while sign-in runs, that a
sign-in start and a bot start racing each other both skip, each on seeing the
other starting, and that the bot stays stopped afterwards. It also holds the sign-in unit's
own start bounds: that `TimeoutStartUSec`, `JobTimeoutUSec` and
`JobRunningTimeoutUSec` come back off a real unit in the order the manager
assumes, that a sign-in whose `collect.lock` is held past the longest the
collector may hold it still reaches `active` with its container running, and
that one held past the unit's start phase ends `Result=timeout` with the
manager giving the sign-in claim back rather than keeping it for the lease.
`scripts/sandbox/reconcile.sandbox.ts` checks drift, a Podman upgrade and when a
token may leave. `scripts/sandbox/collector.sandbox.ts` has a bot plant links and
FIFOs at every name the collector takes, and holds a truncate past its deadline.
`scripts/sandbox/removal.sandbox.ts` removes running bots, races starts against
removal and tears a host down. `scripts/sandbox/instance-stop.sandbox.ts` proves
a bot's stop on Debian 12.
`scripts/sandbox/journal-cursor.sandbox.ts` runs the status observer's own
journal commands on all three base images and holds what journald does with a
position: it resumes at the line the cursor names, returns just that one line
when nothing has happened since, still resumes after that entry has been vacuumed
away, bounds a resumed read forward from the cursor rather than back from the
newest line, shows nothing and names no position when the cursor is ahead of the
journal, and refuses a position it cannot seek to in the words the manager reads.
Start every Podman command in a sandbox test through `shell`, never a direct
`exec`: a process started straight from `docker exec` is AppArmor-unconfined, so
on a kernel with `apparmor_restrict_unprivileged_userns=1`, as on GitHub's Ubuntu
runners, the account's first Podman command cannot create its user namespace.
Never set that sysctl to 0 to get past it; real Ubuntu hosts keep it.
Exec into a bot's container through the user manager, as `inContainer` in
`scripts/sandbox/podman-account.ts` does with `systemd-run --user --wait --pipe`:
on Debian 12, Podman 4.3.1 with crun 1.8.1 can refuse a `podman exec` whose
caller's open-file limit is below the container's. The product never execs into
a bot; a feature that does must go through the user manager too.
Assert on a unit's journal through `journalShowing` in
`scripts/sandbox/sandbox.ts`, never a single `journalctl` read: journald ingests
a unit's own stdout and stderr asynchronously, and `systemctl start` returns when
the job completes, not when that output has landed. systemd's own lines are
already there because systemd writes them itself, so a one-shot read looks
convincing right up to the moment it loses the race, as Debian 12 did.
`journalShowing` re-reads until the line it was given shows, or for
`JOURNAL_WAIT_MS`, and returns what it last saw so the assertion, not the
helper, is still what fails.
**A sandbox test that asserts on journal content must reach it through
`journalShowing`, never through a bare read.** The write path is asynchronous and
a bare read only loses under load, so it passes locally and on two of three
images and fails on the third, on someone else's branch. Two newly-added tests
have now raced journald *after* this helper existed to prevent it.
**And the text waited for must be unique to the run that just wrote it.** The
second of those two did call `journalShowing` — and still raced, because it waited
for `probe line 4` while an earlier run in the same file had already written that
exact line. The helper matched history, returned at once, and the wait was a no-op.
A marker a previous run could have written is not a wait. Tag each run
(`scripts/sandbox/journal-cursor.sandbox.ts` puts a `randomUUID` slice in both the
lines it logs and the unit's `Description`) and wait for the tagged form. Wait for
the unit's **own** last line too, not only the process's: `systemctl start`
returns once the job completes, so systemd's `Finished` is submitted after the
program's last write but travels a different transport, and seeing one says
nothing about the other.
`journalShowing` and `neverShowed` take an optional deadline, defaulting to
`JOURNAL_WAIT_MS`. Raise it for a file that runs alongside the rest of the suite
rather than raising the shared constant: on a full run with images still building,
a unit's `Finished` has been seen in the journal while the five lines its own
process wrote were still not there **thirty seconds later**. That is a deadline,
not an expected duration — a green run says nothing about how much of it was used.
`SANDBOX_PLATFORM=linux/amd64` builds and boots
every host on that platform; on an arm64 Mac, emulation boots Debian 12 but not
rootless Podman, and boots neither Debian 13 nor Ubuntu 24.04.

No sandbox container is given a host path, home directory, `~/.ssh` or the
Docker socket. Every `docker` call goes through the guard in
`scripts/sandbox/sandbox.ts`, and files reach a container on `docker exec` stdin.
A host is privileged, so this is not isolation from the kernel or its devices.
The image masks `systemd-sysctl`, `systemd-binfmt` and `systemd-modules-load`,
which would otherwise apply the image's kernel settings to the machine running
the suite at every boot, and `scripts/sandbox/host.sandbox.ts` fails if any of
them is not masked. Every container carries the
`open-mcc.sandbox` label and a label for its run. It is stopped with
`--timeout -1`, which lets systemd shut down and never escalates to a kill, and
then removed with its volumes. The global teardown removes whatever its run left
even when a test failed. Nothing in the suite force-removes or kills a container,
and the guard refuses both: a forced removal of a systemd sandbox once blocked
the shared Docker engine for 87 minutes. A container that does not shut down
fails the run and is named, for a person to remove.

It is not part of `pnpm test`. It needs a Docker engine that allows privileged
containers, and it takes minutes. CI runs it as its own `sandbox` job. Without
Docker its global setup fails loudly; it never skips. On a machine short of
memory, run it as `pnpm test:sandbox --maxWorkers=2`, and the unit suites as
`pnpm exec turbo run test --concurrency=2`.

A green run does not prove what a container cannot reproduce. systemd there has
no real boot or login session, and linger is observed through logind alone.
`self-host.sh`'s probe needs Docker, which the sandbox does not have, so the
tests that need a finished run put a stand-in `docker` on `PATH`. Real
reachability from the manager's container to its host is exercised by nothing
here. Only the setup script's `apt` path for Podman runs, on Debian 12. The
script installs Podman only when it is missing, and refuses a host that has
neither Podman nor `apt`; nothing else gates on the distribution. A container
runs on this machine's kernel, so the Ubuntu target proves Ubuntu's packages,
not an Ubuntu kernel or its AppArmor.

The installer test is a full run: it builds the images, starts the stack with
its own Postgres, and waits for `/healthz`. It runs as root inside `docker:dind`,
which has no systemd, `loginctl` or `sudo`. `scripts/sandbox/install-as-root.sandbox.ts`
runs the real installer as root on a systemd host instead, with a stand-in
`docker`, and proves it offers nothing and leaves lingering alone there. Neither
test exercises the offered path, or lingering for an account that is not root.
