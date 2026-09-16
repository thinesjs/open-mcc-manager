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
| `never` outside `exhaustive.ts` | `check-type-policy.mjs` |
| `unknown` outside `boundary/` | `check-type-policy.mjs` |
| Derived types, never hand-written | nothing — review only |
| Discriminated unions with `assertExhaustive` | nothing — review only; the helper itself is covered by `packages/core/src/lib/exhaustive.test.ts` |

Twenty rules stated further down this document are enforced too, and are listed
here for the same reason — so that nothing claims enforcement it does not
have:

| Rule | Enforced by |
| --- | --- |
| Organization scope on every repository method but the exceptions named under Tenancy | TypeScript — the scope is a required parameter, so a call without one does not compile |
| Operator-facing copy for every wire error code | TypeScript — `apps/web/src/lib/errors.ts` types its table `Record<ErrorCode, string>` over `packages/contracts/src/errors.ts` |
| Design tokens pinned against drift | `apps/web/src/index.css.test.ts` — every declaration compared by scope, name and value |
| The documented `.env` setup path | `scripts/load-env.test.ts` |
| The host status union matching between `packages/db` and `packages/contracts` | TypeScript in one direction only — `host.controller.ts`'s `toHostPublic` rejects a database union wider than the contract's. A contract union wider than the database's compiles and passes every test, so that direction rests on review |
| Every domain error class carrying a wire error code | `apps/server/src/errors.test.ts` — the classes are read off what `@open-mcc/core` and `apps/server/src/errors.ts` export, so a new one with no case in `mapKnownError` fails |
| The provisioning claim conditioned on the status read before the lock | `packages/core/src/host/host.controller.transaction.test.ts` — substituting the row read under the lock makes the claim always succeed, and fails the test named for it |
| Every `var()` resolving to a declared or Tailwind-provided property | `apps/web/src/index.css.test.ts` — `TAILWIND_PROVIDED` is an explicit list of the names Tailwind supplies, never a `--color-*` prefix |
| The opaque fallback on the glass surfaces staying `!important` and negatively guarded | `apps/web/src/index.css.glass.test.ts` — the inverted form moves the blur inside a positive `@supports` and drops the `@supports not` block, so rewriting it that way fails |
| Only reviewed read builders turning text into a command a shared connection runs | `packages/core/src/instance/read-command-allowlist.test.ts` — every source file naming `asReadCommand` is compared against an exact list, so a new caller fails. It proves who can mint a read command, NOT that the command only reads: `asReadCommand` accepts any string, so a write minted inside an allowlisted file passes, and `HostReader.forward` is not covered at all |
| The provisioning lease covering the worst-case remote work | `packages/core/src/host/host.controller.test.ts` — the budget is computed from the steps `provisionHost` actually runs, so adding one fails the test |
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
| A running bot keeping the token it started on | `packages/core/src/instance/unit.test.ts` — runs the env command under `/bin/sh` against a `systemctl` shim, once per state in `RUNNING_UNIT_STATES`, and requires `kept` on stdout with `env` and `unit.env` byte-identical, so narrowing the case list to `active` fails it; `instance.controller.test.ts` requires no `writeTokenUnderClaim` on a `kept` answer |

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
`coverage`, `.git` and `.turbo` — the list `biome.json` excludes, plus
`.git`. Change one list and change the other.

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
- `CONFIG_CLAIM_LEASE_MS` (`instance.repository.ts`) leases one bot's config
  claim for 180s. `claimForConfig` and `claimForLifecycle` take it — the second
  also refuses a live sign-in claim, because start, restart, stop and remove
  must not run under one. **That refusal lasts the sign-in's own lease, 15
  minutes** (`AUTH_LEASE_MS`), and a sign-in whose SSH work ended uncertainly
  keeps its claim for all of it rather than release a stop that may still be
  landing. An operator whose sign-in died can therefore be told a bot is busy
  for up to fifteen minutes and be unable to start, restart, stop or remove it.
  Cancel sign-in is the way out, but only when the host answers: it releases the
  claim *after* its connect and its two execs, so on an unreachable host it
  throws first and the operator waits the lease out. Saves are deliberately
  still allowed through, on `claimForConfig`.
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
  exists to race it.
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
other starting, and that the bot stays stopped afterwards.
`scripts/sandbox/reconcile.sandbox.ts` checks drift, a Podman upgrade and when a
token may leave. `scripts/sandbox/collector.sandbox.ts` has a bot plant links and
FIFOs at every name the collector takes, and holds a truncate past its deadline.
`scripts/sandbox/removal.sandbox.ts` removes running bots, races starts against
removal and tears a host down. `scripts/sandbox/instance-stop.sandbox.ts` proves
a bot's stop on Debian 12.
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
