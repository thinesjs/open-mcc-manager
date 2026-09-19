# Command scheduler: triggers, delays and chat matching

## The ask

"Schedule commands on join, and make it extensive — like with delays, run certain commands based
on chat entry."

Three trigger kinds are wanted that the manager does not have: **on join**, **delay/sequence**,
and **on chat match**. One trigger kind already exists and ships: a wall-clock daily command.

## What already exists, and what is actually missing

This is not a greenfield feature. A working command scheduler is deployed end to end:

| Layer | Where |
| --- | --- |
| Contract | `packages/contracts/src/schedule.ts:59` (`scheduledCommandInput`), `:72` (`scheduledCommandPublic`) |
| Table | `packages/db/migrations/0011_instance_command.sql` (`instanceCommand`) |
| Repository | `packages/core/src/instance/command.repository.ts` |
| Due logic | `packages/core/src/instance/due.ts:62` (`isDue`) |
| Tick loop | `packages/core/src/instance/scheduler.ts:34` (`runSchedulerTick`), 30s interval at `:5` |
| Controller | `packages/core/src/instance/instance.controller.ts:961` (`setScheduledCommand`), `:1013` (`runScheduledCommand`) |
| Router | `apps/server/src/routers/instance.router.ts:143` |
| UI | `apps/web/src/components/scheduled-commands.tsx` |
| Wiring | `apps/server/src/bootstrap.ts:226` |

So "nothing of this is abstracted into the UI" is true only of the three *new* trigger kinds. The
existing surface is a daily timer: `daysOfWeek` + `minuteOfDay` + `timezone`, one command, one
line, 256 bytes (`INSTANCE_COMMAND_MAX_BYTES`, `packages/contracts/src/schedule.ts:51`).

**This spec extends that feature. It does not replace it.** Any design that introduces a second,
parallel scheduler is wrong.

Note also that `instanceSchedule` (migration `0010`) is *not* a command scheduler despite the
name — it is the sleep window that stops and starts the instance, rendered to systemd timers by
`packages/core/src/instance/schedule.ts:61`. Do not overload it.

## Client version check

`MCC_VERSION` is `20260829-511` (`packages/core/src/host/mcc-release.ts:1`).

The behaviour in this spec was verified by reading the client source **at tag `20260829-511`
itself**, not at whatever a local checkout defaults to. AGENTS.md:515 records why that matters: a
clone once sat 15 months behind and a whole round of "verified against the client" was checked
against a version that never had the feature under discussion.

Two local checkouts exist and neither has 511 checked out. One has 511 in its object store; the
other is one build behind at `20260829-510`. The 510→511 delta is a single file in the protocol
handler, 10 insertions and 1 deletion; the bot and settings trees are byte-identical between the
two tags, verified by comparing git tree and blob hashes rather than dates. So the one-build gap
is immaterial *to this feature specifically* — but the check is the point, not the result. Re-do
it rather than inheriting this paragraph's conclusion when the pin moves.

## Decision: MCC-native triggers, control-plane-owned authoring

**Trigger evaluation and step sequencing belong in the client. Authoring, validation, storage,
audit and artifact delivery belong in the control plane.**

The client already has both bots this feature needs, and both are already part of the config
surface this repo renders:

- A **script scheduler** bot whose tasks carry a first-login trigger, an every-login trigger, a
  wall-clock times trigger and a randomised min/max interval trigger, each with an action string.
  The login triggers fire from the client's own after-game-joined hook and reset on disconnect, so
  "on join" means *this session joined*, evaluated in-process.
- An **auto-respond** bot that reads every incoming line, classifies it as public chat, private
  message or other, and matches each against a rule list. Rules support either a substring match
  (case-insensitive) or a full regex, with per-rule cooldown, separate actions per message class,
  an owners-only flag, and regex capture groups exposed to the action as positional substitutions
  and as script variables. The sender name is substitutable too.
- A **script** bot that reads a plain-text file, one command per line, with comments and a wait
  instruction taking either a fixed tick count or a min–max range it randomises. Both bots above
  dispatch to it when their action names a script, and the script scheduler keys each task's
  script to the task so a re-fire replaces rather than stacks.

Tick rate is 20/second, so wait resolution is 50ms.

That is, verbatim, the three missing trigger kinds plus delays — already written, already tested
upstream, already running in the process that holds the connection.

### Why not control-plane-side

Each of the three fails on something concrete in *this* repo, not on taste.

**On join.** The control plane has no join event. `readConsole`
(`packages/core/src/instance/control.ts:104`) is a bounded pull — `journalctl --lines N` with N
capped at 1000 (`:111`) — invoked per request. There is no follow, no cursor, no stream. Detecting
a join control-plane-side means adding a persistent `journalctl -f` channel per instance, plus
offset persistence, plus restart dedup. The client fires its own hook for free.

**Chat match.** Same transport gap, worse consequences. A busy server can produce more than 1000
journal lines between two 30-second scheduler ticks, so a poll-based matcher would *silently miss
matches* — and a chat trigger that sometimes does not fire is worse than no chat trigger. The
client's matcher sees every line in-process, with a cooldown already implemented per rule.

**Delays.** `sendCommand` (`control.ts:83`) is one SSH `exec` per command line. A five-step
sequence with waits is five SSH round trips whose success is unverifiable — AGENTS.md:35 records
that a FIFO write returns 0 whether or not anything reads it, because systemd holds the pipe open,
and that this was verified directly. Sequencing control-plane-side means N unverifiable writes
spread over N round trips. The client's wait runs in the tick loop.

### Why not fully MCC-native either

Because both bots dispatch their action through the client's **entire** internal command surface,
and that surface includes loading a script — including a C# script the client compiles at runtime.
That is arbitrary code execution in the bot's container, as the one account every bot on the
host runs as.

This repo has deliberately closed that surface, twice:

- `FIXED_CONFIG_KEYS` renders the live-control `ChatAndCommands` and `Movement` capabilities as
  literal `false` (`packages/core/src/instance/config.ts:41`, rendered at `:206`), which
  AGENTS.md:522 says exists precisely to keep the client's internal command surface, "`script`
  included", out of reach, and instructs: "Never enable those two to make a feature easier."
- The control FIFO carries a 30-entry allowlist, `INTERNAL_COMMANDS`
  (`packages/core/src/instance/control.ts:12`). `script` is absent, as are `send`, `set`, `execif`
  and `execmulti`. `controlLine` (`:63`) throws `DisallowedInternalCommandError` on anything else.

There is a third precedent worth copying rather than just citing: `instanceConfigInput`
(`packages/contracts/src/instance.ts:71`) is `.strict()` over 13 *semantic* fields
(`antiAfkEnabled`, `autoRelogRetries`, …). An operator can never name an MCC config key at all —
the renderer translates intent into keys. The allowlist is a declaration checked by tests, not a
runtime filter over operator-supplied key names.

Handing a bot an operator-authored free-text action string reopens the closed surface from a
different direction, with no allowlist in front of it. The client's own documentation for the
auto-respond bot warns that server admins can spoof chat with `/nick` and `/tellraw` — so a chat
trigger's input is **attacker-influenced**, and a chat rule whose action is unvalidated free text
is a remote code execution path into the host.

### The split

The control plane owns the artifacts. **An operator never writes a client action string.** The UI
collects structured steps; the renderer emits only action strings it generated itself, each
validated through the same allowlist that guards the FIFO. The client then evaluates triggers and
runs sequences natively, which is what it is good at.

This keeps native execution and the closed surface at the same time.

## Rendering and delivery

Config delivery today writes exactly one file:
`(umask 077; cat > <dir>/config/MinecraftClient.ini)`, into the `config/` directory `create`
made, in `writeConfigDocument` (`packages/core/src/instance/instance.controller.ts`). The unit
mounts `config/` read-only at `/config`. There is no SFTP; the document is piped over stdin
into `cat` through `HostTransport.exec`.
`renderInstanceConfig` (`config.ts:159`) hand-builds the whole document line by line from a fixed
template; there is no arbitrary-key mechanism and no multi-file support.

This feature needs three artifacts, so the renderer grows a document set rather than a string:

1. `MinecraftClient.ini` — gains a script-scheduler section with one task per non-chat trigger,
   and an auto-respond section pointing at the matches file.
2. `matches.ini` — one block per chat rule.
3. `scripts/<triggerId>.txt` — one plain-text script per trigger that has more than one step or
   any delay. **`.txt` only. The renderer must never emit a `.cs` file**, and must reject a
   trigger id that is not `[a-z0-9-]+`, since the id becomes a filename.

All three would go through the same `umask 077` write into `config/`, which the unit mounts
read-only at `/config`. The client resolves a relative file name against its working
directory, `/data`, so the rendered documents must name the matches file and the scripts by
their `/config/…` paths.

### The array-of-tables problem, and what to do about it

**This is the highest-risk part of the design and it is not hypothetical.** The script scheduler's
task list is an array of tables. The repo's config model cannot represent one today, and it fails
in two independent places:

1. `readMccConfigKeys` (`packages/contracts/src/boundary/mcc-config.ts:47`) descends a dotted path
   and accepts only a scalar, or a `{min, max}` record it can collapse (`:18`). An array-of-tables
   path descends to an `Array`, and `isRecord` explicitly excludes arrays (`:15`). The key
   therefore lands in `unreadable`, and `compareInstanceConfig`
   (`packages/core/src/instance/config-drift.ts:42`) turns that into permanent, uncorrectable
   `kind: "unreadable"` drift for any listed key.
2. The parity test `config.test.ts:99` — "emits exactly the keys `ALLOWED_CONFIG_KEYS` names, so
   the list cannot drift from the output" — walks rendered lines, treating any `[`-prefixed line as
   a section header via `line.slice(1, -1)`. An array-of-tables header `[[...]]` leaves a stray
   bracket in the section name, so its keys emit as paths in neither list and the test fails.

The one saving grace, and the basis of the recommendation: drift only reports an unreadable key
**if it is on a list** — `if (!ALL_KEYS.includes(key)) continue` (`config-drift.ts:43`). An
unlisted key is entirely invisible to drift.

**Recommendation.** Add a third declared list — `UNCOMPARED_CONFIG_KEYS` — for keys the renderer
owns but drift cannot compare, and teach the parity test to expect
`[...ALLOWED, ...FIXED, ...UNCOMPARED]` while skipping `[[`-headed sections. This keeps the
"the list cannot drift from the output" property that the existing test exists to protect, and it
states the trade-off in the source rather than hiding it.

**The trade-off is real and must be stated to the owner, not buried:** trigger config becomes
managed-but-not-verified. A hand edit to the task list on the host would not be reported as drift.
The mitigation is that the client rewrites its config on load and on clean exit (AGENTS.md:551) and
`start` re-renders the saved config immediately before launching, so a re-render corrects a hand
edit at the next start — correction by overwrite rather than by detection. Given that
`reconcileHost` is observational only (below), detection would not have corrected it anyway.

The alternative — extending the drift model to understand repeated tables — is honest work in a
boundary module and its tests, and is the right answer if trigger config must be verifiable. That
is a scope call for the owner; see open question 1.

### Two further invariants to honour

- **The row owns the port** (AGENTS.md:539) generalises here: the rendered artifacts must be
  derived from the trigger rows via an `expectedDocumentsFor` (extending `expectedDocumentFor`,
  `instance.controller.ts:250`) so that a save and a reconcile cannot disagree. Four separate bugs
  came from reading a value out of a stale config document; all four typechecked and passed tests.
- Because triggers live in the config, **changing a trigger requires the client to reload it.** The
  client re-reads its settings on an internal reload command, but that command is not in
  `INTERNAL_COMMANDS` and adding it is a scope decision, not a given. See open question 2.

## Data model

Never a Postgres enum (AGENTS.md:232). A constrained column is `text` in the migration, narrowed to
a literal union in `packages/db/src/schema/`, owned by a `const` array in `packages/contracts` —
the pattern `host.status` and `instance.status` set. Narrowing uses the repo's `RefinementOf`
idiom (`packages/db/src/schema/instance.ts:6`) so the union is proven a subtype of what
`kysely-codegen` produced, and the table must be registered in `packages/db/src/database.ts` or the
column stays a bare `string` everywhere (AGENTS.md:454).

`daysOfWeek` already demonstrates the app-level encoding: `"*"` or `"Mon,Tue"`, rendered and parsed
by `renderDaysOfWeek` / `parseDaysOfWeek` (`packages/core/src/instance/schedule.ts:29`, `:41`).

Newer tables also add a `CHECK (col IN (...))` — `0027_status.sql:19` and `0028_notifications.sql`
do; `0009`'s `instance.status` and `0023`'s `accountType` do not. Prefer the check for new columns;
`0029_notification_kinds.sql` widening a check from two values to nine in one migration is exactly
the benefit the no-enum policy cites.

### Trigger kinds

```ts
export const TRIGGER_KINDS = ["dailyTime", "onJoin", "onFirstJoin", "onInterval", "onChat"] as const
export type TriggerKind = (typeof TRIGGER_KINDS)[number]
```

`dailyTime` is what `instanceCommand` already stores. The other four are new.

### Migration

Extend `instanceCommand` rather than adding a table; a trigger is one row with one step list.

```sql
ALTER TABLE "instanceCommand" ADD COLUMN "triggerKind" text NOT NULL DEFAULT 'dailyTime';
ALTER TABLE "instanceCommand" ADD COLUMN "chatPattern" text;
ALTER TABLE "instanceCommand" ADD COLUMN "chatMatchMode" text;
ALTER TABLE "instanceCommand" ADD COLUMN "chatScope" text;
ALTER TABLE "instanceCommand" ADD COLUMN "chatOwnersOnly" boolean NOT NULL DEFAULT false;
ALTER TABLE "instanceCommand" ADD COLUMN "cooldownSeconds" integer;
ALTER TABLE "instanceCommand" ADD COLUMN "intervalMinSeconds" numeric;
ALTER TABLE "instanceCommand" ADD COLUMN "intervalMaxSeconds" numeric;
ALTER TABLE "instanceCommand" ADD CONSTRAINT "instanceCommand_trigger_kind_known"
	CHECK ("triggerKind" IN ('dailyTime','onJoin','onFirstJoin','onInterval','onChat'));
```

`minuteOfDay` and `daysOfWeek` become nullable, gated by kind — `dailyTime` requires both, the
others must leave both null. Existing rows keep the default `'dailyTime'`, so no backfill is
needed. The two existing daily checks (`instanceCommand_minute_within_day`,
`instanceCommand_days_not_empty`) must be re-stated to tolerate null.

Steps are a child table, because a step list is ordered and variable-length while the existing
`command` column is a single 256-byte line:

```sql
CREATE TABLE "instanceCommandStep" (
	"id" text PRIMARY KEY NOT NULL,
	"organizationId" text NOT NULL,
	"commandId" text NOT NULL,
	"position" integer NOT NULL,
	"kind" text NOT NULL,
	"command" text,
	"waitMinMs" integer,
	"waitMaxMs" integer
);
```

Constraints, following the style already in `0011`:

- `UNIQUE("organizationId","id")` and `UNIQUE("organizationId","commandId","position")`.
- Composite FK `("organizationId","commandId") → instanceCommand("organizationId","id")`
  `ON DELETE cascade`. This is the constraint AGENTS.md:44 depends on: it is why
  `runScheduledCommand` needs no `ActorContext` and derives scope from `row.organizationId`
  alone. **Do not drop it** — without it a background loop would need a privileged identity.
- `CHECK ("kind" IN ('command','wait'))`, plus `kind = 'command'` implies `command IS NOT NULL`
  and `kind = 'wait'` implies `waitMinMs IS NOT NULL`.
- Reuse `0011`'s two command checks per step: non-empty, and `!~ '[\n\r]'` (single line). The DB
  mirroring `hasControlCharacter` is deliberate and worth preserving.
- `CHECK ("position" >= 0)`.
- Cap step count per trigger in the contract, not the schema — a check constraint cannot count
  siblings, and a 400-step trigger is a config-size problem, not an integrity one.

`chatMatchMode` is `'substring' | 'regex'`; `chatScope` is `'public' | 'private' | 'other'`. Each is
a `const` array in contracts, a `text` column with a check constraint, and a narrowed union in
`packages/db/src/schema/instance.ts`.

Keep `instanceCommand.command` for `dailyTime` single-step rows so existing rows and the existing
UI keep working, and treat a row with steps as authoritative over it. A row must not have both.

The step repository should follow `whitelistInstanceUpdate` / `MUTABLE_INSTANCE_COLUMNS`
(`instance.repository.ts:10`, `:27`) and write `organizationId` into the SET clause last, so a
smuggled patch cannot move a row between organizations.

### Branching on kind

`packages/core` uses a `switch` with `assertExhaustive` from
`packages/core/src/lib/exhaustive.ts` — the only place `never` may appear. `apps/web` branches over
kind unions with a `Record` lookup, the way `host-status.ts` already does.

## How each trigger is expressed

| Kind | Stored as | Rendered as |
| --- | --- | --- |
| `dailyTime` | `daysOfWeek` + `minuteOfDay` + `timezone` | unchanged — control-plane tick, existing path |
| `onJoin` | `triggerKind = 'onJoin'` | a task with the every-login trigger set |
| `onFirstJoin` | `triggerKind = 'onFirstJoin'` | a task with the first-login trigger set |
| `onInterval` | `intervalMinSeconds`, `intervalMaxSeconds` | a task with the interval trigger and its min/max |
| `onChat` | `chatPattern`, `chatMatchMode`, `chatScope`, `chatOwnersOnly`, `cooldownSeconds` | a matches-file block whose action is the trigger's script |

A trigger's steps render to its action:

- One `command` step, no waits → the action is that command directly.
- Anything else → the action names `scripts/<triggerId>.txt`, and the script file carries one
  command per line with a wait line per `wait` step. `waitMinMs` alone renders a fixed wait;
  `waitMinMs` with a distinct `waitMaxMs` renders the randomised range form. Milliseconds convert
  to ticks at 20/second and must be a multiple of 50ms, validated in the contract — a 25ms wait
  would silently round, and the UI should refuse it rather than lie.

`dailyTime` deliberately stays control-plane-side even though the client could express it. It
already works, it has `lastRunAt` / `lastRunError` observability the native path cannot give, and
its 60-minute catch-up grace (below) is behaviour the client does not have. Moving it would be a
regression dressed as consistency.

Chat capture groups are the one place operator text reaches a command argument. See Security.

## Security surface

A scheduled command is arbitrary remote execution on a game server, and — via the client's script
loading — potentially on the host. Treat every layer as load-bearing.

### Who may create one

`setScheduledCommand` requires `console.write` (`instance.controller.ts:965`), and
`deleteScheduledCommand` the same (`:993`). Per `packages/contracts/src/authz.ts:30`,
`console.write` is held by `operator` and `owner`, not `viewer`. The role set is exactly
`owner | operator | viewer` — there is no `admin`. **Keep that guard for the new kinds.**

Enforcement is doubled and both halves are required: `requireCapability` as the first statement of
each procedure (`apps/server/src/trpc.ts:39`, throwing `TRPCError` `FORBIDDEN`) and
`requireCapabilityFor` in the controller (`instance.controller.ts:148`, throwing `ForbiddenError`
so `packages/core` stays framework-agnostic).

One change is warranted: an `onChat` trigger is qualitatively different from a timer, because its
firing is influenced by anyone who can put text in chat. Add a capability `schedule.chatTrigger`
to `CAPABILITIES` (`authz.ts:12`) granted to `owner` only, and require it in addition to
`console.write` when `triggerKind = 'onChat'`. A chat trigger is a standing delegation of command
execution to the chat channel; that should be an owner's decision.

### What is validated

1. **Every command step passes `controlLine`** (`control.ts:63`) at write time, not just at send
   time. This is the crux of the whole design: the renderer emits only strings the FIFO allowlist
   would already accept, so the native path grants no authority the manual path does not. A step
   naming `script`, `send`, `set`, `execif` or `execmulti` is rejected with
   `DisallowedInternalCommandError`, because none is among the 30 entries in `INTERNAL_COMMANDS`.
2. Reuse `instanceCommandText` (`packages/contracts/src/schedule.ts:53`) per step: non-empty, 256
   bytes, no `\n` or `\r`. Reuse `hasControlCharacter`'s rule (`control.ts:53`) — reject any
   codepoint below 0x20 or 0x7f, which is what stops a step smuggling a second FIFO line.
3. **Chat captures are the sharpest edge.** A capture group interpolated into a command argument is
   attacker-controlled text, and the client warns chat is spoofable via `/nick` and `/tellraw`.
   Rules:
   - A capture may only be interpolated into a step the renderer marks as accepting one.
   - The interpolated value must be constrained at the *pattern* level: a capture destined for a
     command argument must be a bounded character-class group, not `.*`. Reject a pattern whose
     capture groups are unbounded.
   - The rendered script must never place a capture where a command *name* is read. Arguments only.
4. **Regex denial of service.** An operator-supplied regex runs in the client's receive path on
   every line. A catastrophically backtracking pattern wedges the client — and AGENTS.md:24 already
   documents that a wedged client reports `active` while doing nothing. Cap pattern length, reject
   nested quantifiers, and require a non-zero `cooldownSeconds` for `onChat`. The client applies
   the cooldown per rule, so this is enforceable at render time.
5. **Filename injection.** `scripts/<triggerId>.txt` puts an id in a path. Validate against
   `[a-z0-9-]+` the way `validateInstanceId` (`packages/core/src/instance/unit.ts:8`) already
   guards unit names — note it also rejects `%` to stop systemd specifier expansion — and
   shell-quote regardless.
6. `.cs` is never rendered, and the renderer should assert on the extension it writes rather than
   trusting a caller.

Every new error class must be mapped in `apps/server/src/errors.ts`, given a code in
`packages/contracts/src/errors.ts`, and given operator copy in `apps/web/src/lib/errors.ts` —
`errors.test.ts` derives the expected set from the domain exports, so an unmapped class fails
rather than silently returning a 500.

### Audit

Every mutation already records to `auditEvent` with `action: "instance.schedule"` and the command
in `detail` (`instance.controller.ts:978`), and every fire records `action: "instance.command"`
with `actorLabel: SCHEDULER_ACTOR_LABEL` (`instance.controller.ts:1032`, `scheduler.ts:7`). The
write and its audit row commit together via `withTransaction`.

Native triggers break this, and it is the real cost of the decision: **a client-side fire produces
no control-plane audit record**, because the control plane is not in the loop. Mitigations, in
order of preference:

1. Audit the *installation* of a native trigger as the privileged act, and say plainly in the UI
   that individual native fires are not individually audited.
2. Surface fires from the journal in the instance console view, which already reads it — the client
   logs each task action it runs. This is observability, not audit; do not label it audit.

Do not fabricate audit rows for fires the control plane did not observe. Note `auditEvent` has no
router and no UI today, so audit is write-only from the app's perspective; that is a pre-existing
gap this feature should not pretend to close.

## When a trigger fires while the instance is down

The two paths differ, and the UI must not pretend otherwise.

**`dailyTime` (control-plane).** Behaviour exists and is correct. `runScheduledCommand` throws
`InstanceNotRunningError` if `instance.status !== "running"` (`instance.controller.ts:1019`).
`runSchedulerTick` catches it, records it to `lastRunError`, and continues (`scheduler.ts:83`).
`isDue` has a 60-minute catch-up window — `CATCH_UP_GRACE_MINUTES` (`due.ts:4`) — so the tick
retries every 30 seconds for up to an hour, and `claimRun` plus the `lastRunAt` date-key check
(`due.ts:72`) makes it fire at most once per local day. An instance down for its whole window
records the error and does not fire. **This is the right behaviour: keep it.**

`claimRun` is a real atomic DB claim rather than a formality, but note the control plane is a
singleton — `acquireSingletonLock` (`apps/server/src/singleton.ts`) takes a Postgres advisory lock
and exits if it is lost — so the claim currently guards against a second replica that cannot exist.
Do not remove it on that basis; it is what makes the loop correct if the singleton assumption ever
changes.

**Native triggers.** There is nothing to fire. The client is the thing that is down. `onJoin` and
`onFirstJoin` self-heal by definition — the next start *is* a join, so they fire then.
`onInterval` and `onChat` simply do not run while down, with no backlog and no catch-up.

One asymmetry to be deliberate about: `onFirstJoin` is first-login *per client process*, not per
instance lifetime, and it resets when the process restarts. With `Restart=on-failure` and
`RestartSec=30` in the unit, a crash-restart loop re-fires it. Say so in the UI; do not describe it
as "once ever".

A `dailyTime` fire is also **not** proof of execution. AGENTS.md:35: systemd holds the FIFO open, so
a write lands in the pipe buffer and returns 0 whether or not anything reads it — verified
directly, and the unit opens the FIFO read-write on fd 3 specifically so it never sees EOF. A
wedged-but-`active` client accepts every scheduled command and runs none. The UI must not render a
successful send as a successful execution, and `lastRunError == null` means "sent", never "ran".
Reconciliation's `stuck` state (AGENTS.md:39) is the signal that distinguishes them.

## What proves it works

`pnpm test` (turbo, root `package.json:10`), `pnpm typecheck`, `pnpm check`,
`pnpm check:types-policy`. Tests are colocated `*.test.ts` beside their subject.

Database-backed tests need a migrated test database, and the variable name changes between the two
commands — `db:migrate` reads `DATABASE_URL` while the suites read `TEST_DATABASE_URL`. Per
AGENTS.md:670, `fileParallelism: false` orders files *within* `@open-mcc/server` only, so **no new
test may assume a table is globally empty**, and cleanup must run on the failure path via an
`afterEach` over tracked ids rather than as the last statement of an `it` body.

### Contracts

1. `scheduledCommandInput` accepts each of the five kinds with its required fields and rejects each
   with a field belonging to another kind — `onChat` without `chatPattern`, `dailyTime` without
   `minuteOfDay`, `onJoin` *with* `minuteOfDay`.
2. A wait that is not a multiple of 50ms is rejected.
3. `intervalMinSeconds > intervalMaxSeconds` is rejected.
4. An `onChat` with `cooldownSeconds` of 0 or null is rejected.
5. A regex with a nested quantifier is rejected; a bounded character-class capture is accepted.
6. A step of 257 bytes, a step containing `\r`, and a step containing a codepoint below 0x20 are
   each rejected.

### Validation and the allowlist

7. **A step naming `script` is rejected.** So are `send`, `set`, `execif`, `execmulti`. This is the
   test that guards the decision; if it ever passes a `script` step, the closed surface is open.
8. Every command the renderer emits round-trips through `controlLine` without throwing — asserted
   over a fixture covering all five kinds, so the renderer cannot emit something the FIFO would
   reject.
9. A trigger id outside `[a-z0-9-]+` is rejected before any path is built; `../`, an absolute path,
   and a `%` are each rejected explicitly.
10. The renderer never produces a document set containing a `.cs` path.

### Rendering and drift

11. A single-command trigger with no waits renders its command as the action directly, and produces
    **no** script file.
12. A multi-step trigger renders a script file whose lines are in `position` order, with waits
    converted to ticks at 20/second.
13. A `waitMinMs` equal to `waitMaxMs` renders the fixed form; a distinct max renders the range form.
14. Chat rules render one block per rule, with cooldown, scope-appropriate action, and owners-only
    reflected.
15. A capture group renders only into an argument position, never a command name — asserted on the
    rendered text.
16. `expectedDocumentsFor` is the single source for both the save path and the reconcile path:
    given one row set, `writeConfigDocument` and `reconcileHost` produce byte-identical document sets.
    This is the regression test for the class of bug AGENTS.md:539 describes.
17. Rendering is deterministic — same rows, same bytes, twice — or drift will flap.
18. **A config with no triggers renders byte-identically to today's output.** This proves the
    feature is inert when unused and protects every existing `config.test.ts` expectation.
19. The parity test at `config.test.ts:99` still holds with the third list added, and a rendered key
    absent from all three lists still fails it. This test is the reason the allowlist cannot rot;
    weakening it to accommodate the task list would remove the guarantee it exists for.
20. `compareInstanceConfig` reports no drift for a config carrying triggers — needs a real captured
    round-trip from build 511, not a hand-written fixture. See open question 1.

### Due logic and the tick

21. `isDue` is unchanged for `dailyTime`. Existing `due.test.ts` must pass untouched.
22. A non-`dailyTime` row is never returned by `dueCommands` and never fires from the tick — the
    control plane must not double-fire what the client owns.
23. An instance that is not `running` records `lastRunError` and does not fire (extends the case at
    `instance.controller.test.ts:534`).
24. Catch-up still fires within 60 minutes and not after; still at most once per local day across a
    DST boundary in a zone that has one.

### Authorization

25. `viewer` cannot create, edit or delete any trigger kind.
26. `operator` can create `dailyTime`, `onJoin`, `onFirstJoin`, `onInterval`.
27. `operator` **cannot** create `onChat`; `owner` can. This is the new guard, so it needs the test.
28. A trigger cannot be created against another organization's instance — covered by
    `requireInstance`, asserted per new procedure.
29. Both guards fire independently: the controller rejects an under-privileged `ActorContext` even
    when the router check is bypassed.

### UI

30. The step editor cannot submit a step list that fails contract validation.
31. Each kind's copy states its down-time behaviour, and `onFirstJoin` is described as per-process.
32. A sent-but-unconfirmed fire is not shown as "ran".

## What the UI shows and collects

Extend `apps/web/src/components/scheduled-commands.tsx` rather than adding a second card; a trigger
list with a kind badge is one concept. Per the standing note that UI copy must stay lean, the
surface below is deliberately small and the detail goes in tooltips.

**List.** Name, kind badge, first step (truncated, monospace, as today), enabled toggle, delete. For
`dailyTime` keep the existing time and days display and the `lastRunAt` / `lastRunError` indicator.
For native kinds show the trigger condition in place of the time, and **no** last-run column — the
control plane does not know. An empty last-run cell is a lie by omission; use a tooltip saying
fires are logged to the console instead.

**Editor.** Kind picker first, because it determines every other field. Then, per kind:

- `dailyTime` — time, days, timezone. Unchanged.
- `onJoin` / `onFirstJoin` — nothing but the steps.
- `onInterval` — min and max, in seconds, with the randomisation stated.
- `onChat` — pattern, match mode (substring or regex), scope (public / private / other),
  owners-only, cooldown. Substring is the default; regex is the advanced path and should say a bad
  pattern can wedge the client.

**Step editor**, shared by all kinds: an ordered list of rows, each a command or a wait, with
add / remove / reorder. A command row is a text input validated against the allowlist client-side
so the error arrives before submit; `INTERNAL_COMMANDS` is already a `const` array exported from
core (`packages/core/src/index.ts`) and can be surfaced to the web app. A wait row takes a duration
and an optional "up to" for a range.

**Two things the UI must say plainly**, because both are surprising:

1. A native trigger takes effect only after the instance next picks up its config — and a save made
   while the instance is running may be discarded by the next stop (AGENTS.md:551). The editor
   should either offer a restart or state when the change lands. This is the worst
   available-behaviour edge in the feature and hiding it will generate bug reports.
2. Chat triggers act on text any player can send, and chat can be spoofed by a server admin.

## Open questions

1. **Array-of-tables round-trip, and whether trigger config must be drift-verified.** The failure
   modes are now known and documented above, and the recommendation is a third
   `UNCOMPARED_CONFIG_KEYS` list. Two things remain unanswered. First, what the file actually looks
   like after the client has rewritten it — key order, inline versus expanded tables, how an empty
   list is emitted — which needs a real capture against build 511 before the renderer is written.
   Second, and this is the owner's call rather than mine: whether accepting managed-but-unverified
   trigger config is acceptable, or whether the drift model should be extended to compare repeated
   tables. The recommendation assumes the former; the latter is more work and more safety.
2. **Reload without restart.** The client re-reads settings on an internal reload command, but that
   command is not in `INTERNAL_COMMANDS` and its blast radius is wider than this feature — it
   reloads *all* settings and the client prints warnings when it runs. Whether to add it to the
   allowlist so trigger edits apply without a restart is a scope and safety decision I should not
   make unilaterally. Until it is answered, assume a restart is required and say so in the UI.
3. **Which "join" the owner means.** "On join" is ambiguous and the two readings need different
   machinery. *The bot joins the server* is the login trigger, natively. *A player joins the
   server* is a chat rule matching the server's join line in the `other` scope, with the player
   name as a capture. I have specced the first, and the second falls out of `onChat` — but the
   owner should confirm which they wanted, because if it is the second, the UI should offer it as
   its own kind rather than making an operator hand-write a regex for it.
4. **Does an `onChat` rule need per-player rate limiting** beyond the per-rule cooldown? The
   cooldown is per rule, so one player can starve a rule for everyone. The client does not offer
   per-sender limiting, so this needs a different mechanism or an accepted limitation. Note there
   is no rate limiting on the existing command path either, so this would be the first.
5. **Step count and script size caps.** I have said to cap in the contract but not at what number.
   Needs a number grounded in config size and render time rather than a guess.
6. **Whether `onInterval` overlaps `dailyTime` enough to confuse operators.** Two ways to say
   "regularly" in one UI may be worse than one. Possibly a UX question rather than a modelling one.

### Resolved while writing this

- *Does drift correction re-fire `onFirstJoin`?* No, because nothing corrects drift.
  `reconcileHost` (`instance.controller.ts:893`) is observational — it returns a report and is
  called from exactly two places, a router query at `instance.router.ts:177` and
  `apps/web/src/components/host-drift.tsx:35`. Nothing schedules it and nothing acts on it;
  correction is manual via `start`, `restart` or `updateConfig`. So the re-fire question reduces to
  the restart question, which is answered under "when a trigger fires while the instance is down".
