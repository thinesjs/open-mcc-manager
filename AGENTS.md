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

## Prohibitions

- No Next.js, in any form, ever.
- No code comments in application code. Names and types carry the meaning.
- No commit descriptions. Subject lines only, imperative mood, Conventional
  Commits (`type(scope): subject`).
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
| Discriminated unions with `assertExhaustive` | nothing — review only |

Four rules stated further down this document are enforced too, and are listed
here for the same reason — so that nothing claims enforcement it does not
have:

| Rule | Enforced by |
| --- | --- |
| Organization scope on every repository method | TypeScript — the scope is a required parameter, so a call without one does not compile |
| Operator-facing copy for every wire error code | TypeScript — `apps/web/src/lib/errors.ts` types its table `Record<ErrorCode, string>` over `packages/contracts/src/errors.ts` |
| Design tokens pinned against drift | `apps/web/src/index.css.test.ts` — every declaration compared by scope, name and value |
| The documented `.env` setup path | `scripts/load-env.test.ts` |
| Every domain error class carrying a wire error code | `apps/server/src/errors.test.ts` — the classes are read off what `@open-mcc/core` and `apps/server/src/errors.ts` export, so a new one with no case in `mapKnownError` fails |
| The provisioning lease covering the worst-case remote work | `packages/core/src/host/host.controller.test.ts` — the budget is computed from the steps `provisionHost` actually runs, so adding one fails the test |

Everything else in this document — the layering direction, the rest of the
tenancy rules, the host-key trust rules in the dashboard, the mirroring of
design token *values* from the reference — rests on review and on the tests written
alongside each change. No hook, no commitlint, no CI step covers them.

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
subject is not `type(scope): subject` with a known Conventional Commits type,
or that carries a description at all. Merge commits are skipped — their
message is generated, not authored here. CI runs it on pull requests over
`github.event.pull_request.base.sha..HEAD`, which is why the checkout uses
`fetch-depth: 0`; pushes to `main` are not re-checked, because the same
commits were checked on the pull request that introduced them. Run it locally
with `pnpm check:commits origin/main..HEAD`.

Imperative mood is not checked. It needs judgement rather than a regex, so
that half of the rule stays with review.

## Database

- Kysely, not an ORM with its own query builder abstraction on top. `pg` is
  the driver.
- `packages/db/src/generated/database.ts` is generated by `kysely-codegen`
  from the live schema and committed — run
  `pnpm --filter @open-mcc/db db:codegen` against a migrated database after
  adding or changing a table, and commit the diff. Never hand-edit that file.
- Files under `packages/db/src/schema/` narrow the generated types (`Omit`
  a column, redeclare it as a literal union or `Generated<...>`) — they
  refine what codegen produced, they do not declare a table's shape from
  scratch. A free-standing hand-written table type is a sign the migration or
  the codegen step was skipped.
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
| `*.repository.ts` | Kysely queries, org-scoped | business logic, transport calls |
| `*.controller.ts` | business logic, orchestration | import tRPC or HTTP types |
| `*.router.ts` | tRPC procedures, zod validation, capability check | touch the database directly |

- `apps/server/src/routers/member.router.ts` is the one exception to that last
  cell, and it is a standing exception rather than an unconverted file. It
  reads `invitation` and writes `member` directly, in four places, with no
  `member.controller.ts` behind it, because both operations are inseparable
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
  must too.
- `packages/contracts` owns every zod schema. `packages/core` contains none.
- `packages/core` and `packages/transport` stay framework-agnostic — no
  Hono, no tRPC, no HTTP types.
- `PROVISIONING_LEASE_MS` (`host.repository.ts`) must exceed the longest an
  attempt can hold its claim: `CONNECT_TIMEOUT_MS` (`host.controller.ts`) plus
  one `PROVISION_STEP_TIMEOUT_MS` (`provision.ts`) for every command
  `provisionHost` runs — 10s + 2 x 120s against a 300s lease today. The three
  constants live in three files and nothing but that arithmetic ties them
  together, so a third provisioning step would silently push the worst case
  past the lease: attempt A's claim expires mid-flight, a second actor
  legitimately reclaims the host, and A's `finalizeProvisioning` matches no row
  and throws after A has already changed the remote machine. The budget test in
  `host.controller.test.ts` counts the commands a real `provisionHost` call
  issues rather than a written-down step count, so adding a step fails it.
  Raise the lease, or shorten the steps, before adding one.
- Remote effects (an SSH connection, a call into better-auth's own write
  path) never sit inside a database transaction. `host.controller.ts`'s
  `provision` claims the host with a leased status update, does the SSH work
  entirely outside any transaction, then finalizes in a second transaction —
  a crash mid-attempt leaves a recoverable claim, not a hung lock.
  `member.router.ts`'s `acceptInvitation` calls better-auth's `signUpEmail`
  (a connection this codebase does not control) before opening the
  transaction that inserts the member row and audits it; a failure after
  signup leaves an orphaned user with no membership, which is inert because
  the request context rejects any session with no matching member row. A
  formal saga engine with idempotency keys and per-phase checkpoints is
  scoped for later and does not exist yet.

## Tenancy

Every table carries `organizationId`. Every cross-entity foreign key that
crosses into another organization-scoped table is composite and includes it
(see `host_sshKey_org_fk`, `auditEvent_actor_org_fk` in the migrations).
Actor columns reference `member`, never the global `user`, except an audit
row's `actorLabel`, which is a label captured at the time of the action, not
a live reference, and survives the member being deleted. Repositories take
an organization scope (`{ organizationId }`) as a required first argument on
every method — there is no method that queries or writes without one, and
that includes `host.repository.ts`'s `lockHost`, which takes no organization
predicate but folds the organization id into the advisory lock key so one
tenant cannot stall another's host that happens to share an id. The compiler
is what enforces this: a method without the scope parameter cannot be called
without one.

## Auth

Registration is closed (`emailAndPassword.disableSignUp`) — there is no
public sign-up endpoint. The first owner is created by a deployment-time
bootstrap (`pnpm --filter @open-mcc/server bootstrap:owner`, reading
credentials from environment variables), which refuses to run if any user
already exists, serialized with a Postgres advisory lock so two concurrent
runs cannot both win. Every subsequent member arrives by invitation: an
existing member holding `member.manage` issues one, and the invited person's
account is created only as part of accepting that specific, still-pending
invitation. Password hashing is Argon2id, configured explicitly
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

## Adding a domain end to end

Worked example: adding an `instance` domain (a running Minecraft server on
a host), following the actual stack above.

1. `packages/contracts/src/instance.ts` — zod input and output schemas
   (`createInstanceInput`, `instanceIdInput`), exported from
   `packages/contracts/src/index.ts`.
2. A new migration file, `packages/db/migrations/0006_<name>.sql`, adding an
   `instance` table with `organizationId text not null references
   organization(id) on delete cascade` and a composite FK back to `host`
   scoped by organization, the same way `host` and `sshKey` do it today. Run
   `pnpm --filter @open-mcc/db db:migrate` against the dev database, then
   `pnpm --filter @open-mcc/db db:codegen` to regenerate
   `generated/database.ts`, then add
   `packages/db/src/schema/instance.ts` narrowing the generated row exactly
   like `host.ts` does for its `status` column.
3. `packages/core/src/instance/instance.repository.ts` — `createInstanceRepository(db: Executor)`
   with org-scoped `insert` / `findById` / `list` / `delete`, matching the
   shape of `host.repository.ts`.
4. `packages/core/src/instance/instance.controller.ts` —
   `createInstanceController(deps)` whose methods check `can(ctx.role,
   "instance.create")` (or the relevant capability) before any side effect,
   then do the work, then audit owner-relevant mutations through the same
   `withTransaction` pattern `host.controller.ts` uses — the repository
   write and its audit row commit together, and any remote effect (starting
   the container over the host's transport) happens outside that
   transaction, not inside it.
5. `apps/server/src/routers/instance.router.ts` — a `protectedProcedure`
   per method, `.input(createInstanceInput)` for validation,
   `requireCapability(ctx.actor.role, "instance.create")` before calling the
   controller, registered on `appRouter` in `apps/server/src/routers/index.ts`.
6. Colocated `*.test.ts` beside each new file. Repository and controller
   tests that hit real Postgres need `TEST_DATABASE_URL` and must include a
   cross-tenant case — organization A's actor must not be able to read,
   modify, or delete organization B's instance.

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
- Design tokens are mirrored from the reference and pinned by
  `apps/web/src/index.css.test.ts`, which parses `index.css` and compares
  every custom property it declares — all 132 of them, as
  `scope name: value` — against one expected list. Deleting a declaration,
  changing a value, or moving one between the light and dark blocks all fail
  that test. It was previously a set of `toContain` checks on bare token
  names, which a `var()` reference elsewhere in the file satisfied and which
  prefix collision let `--error-foreground` satisfy on behalf of `--error`;
  both `--error:` declarations could be deleted outright with the suite still
  green. Do not go back to substring matching. The mirroring itself — that
  these values match the reference's — rests on review, because the reference is not in
  this repository and a test cannot read it. Reuse existing token families;
  never invent one locally.
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
