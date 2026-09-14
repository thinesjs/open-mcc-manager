# Security

## Trust boundary

The control plane holds credentials — SSH private keys and, through them, the
ability to install and start systemd units — for every host it manages. Every
host is managed the same way. The manager connects as the one account enrolled
for that host and works only inside that account's home directory, under its
systemd user manager. It never asks for root, so enrol an ordinary account: a
stolen key then yields that one unprivileged account rather than the host
itself. The operator runs `loginctl enable-linger <user>` once, by hand, so
instances survive logout and start at boot; provisioning refuses to continue
until they have.

A compromise of the control plane's application process, or of an
authenticated operator's session, is a compromise of the entire fleet. What an
attacker gains on each host is bounded by that enrolled account. A compromise
limited to the database alone is narrower — private keys are stored sealed (see
**Sealed secrets with rotation** below), so a database-only attacker gets
ciphertext they cannot open without also reaching the application process or
its environment secrets. Treat a database compromise as serious regardless —
it exposes host metadata, audit history, and every other stored fact — but it
is not, on its own, equivalent to full fleet root; see **Known limitations**
for the precise boundary.

Managed hosts must therefore be dedicated to this workload. Do not run
unrelated services, secrets, or workloads on a host that open-mcc-manager
provisions. Anything else on that host is inside the same trust boundary as the
Minecraft Console Client instances it runs.

## Supported deployment model

open-mcc-manager supports **one security domain per control plane deployment.**
Organizations are an administrative partition for teams within a single
operator's deployment — grouping hosts, instances, and members under shared
billing or shared ownership. They are **not** a customer-isolation boundary and
must not be relied on to separate mutually distrustful parties. A member of one
organization is not assumed hostile toward another organization on the same
deployment, but nothing in this system is designed to withstand an organization
that is actively hostile to the operator or to other tenants of the same
deployment.

If your use case requires isolating mutually distrustful customers on shared
infrastructure, that requires either a per-host agent brokering a narrow,
authenticated API in place of raw SSH access, or a wholly separate
control-plane deployment per customer. Multi-tenant, hostile-tenant isolation is
not a goal of the current architecture.

Hosts may be reached over the public internet or over a private tailnet, and the
two may be mixed in one deployment. That choice changes the network exposure of
the SSH port, not the trust model: every control described below applies
unchanged either way, and none of them is relaxed because a host is only
reachable privately. Keeping hosts off the public internet is a defence in
depth, not a substitute for one.

## Current controls

- **Closed registration; accounts are provisioned, not self-served.** Public
  sign-up is disabled (`emailAndPassword.disableSignUp`) — the `/sign-up/email`
  endpoint refuses every request, regardless of caller, so nobody can create
  an account by simply reaching the server. That flag covers one method only,
  and it is read once at construction, so it can neither close a social, OIDC,
  SAML, passkey, magic-link or OTP path nor express "open until the first
  account exists". The control that does both is the `user.validateUserInfo`
  gate (`apps/server/src/security/registration-gate.ts`), which better-auth
  calls from `internalAdapter.createUser` — the one seam every method's user
  creation passes through — and which refuses `create-user` whenever any user
  row exists, without reading the identity or the method. A deployment holding
  no account admits the first one; a deployment holding one is closed to every
  method at once, including methods added later, so enabling a social or SSO
  provider cannot reopen registration by accident. `link-account` and `sign-in`
  are admitted, so an existing member can still attach a provider and sign
  back in, and the rejection the client sees names nothing about the
  deployment. `CreateAuthOptions.userCreation` defaults to `gated`, so a new
  auth instance is closed unless it declares otherwise; only the non-mounted
  `signupAuth` used for invitation acceptance is `trusted`, because the router
  has already verified a specific pending invitation before it creates a user.
  `apps/server/src/registration-gate.test.ts` proves the closure per method and
  proves the bootstrap path still works on an empty deployment. The first owner
  is created by a deployment-time bootstrap
  (`pnpm --filter @open-mcc/server bootstrap:owner`, reading credentials from
  environment variables) that refuses to run if any
  user already exists in the database — a bootstrap that succeeds twice would
  be a backdoor, so this is enforced as a hard precondition, not a warning.
  Every subsequent member is added by invitation, issued by an existing
  member holding `member.manage` (owner only, per the capability matrix
  below); the invited person's account is created only as part of accepting
  that specific, pending invitation — never through the public endpoint —
  and lands in the inviting organization with exactly the role the invitation
  named. That role may be `owner`, and deliberately so: `member.manage` is
  owner-only, so only an owner can issue any invitation at all, and accepting
  an invitation is the only code path in this system that ever writes a
  member's role — there is no procedure that changes one afterwards. An owner
  inviting an owner is therefore succession, not escalation: the inviter
  already holds every capability the invitee receives, and a deployment whose
  only owner is the bootstrap account would otherwise have no way to add a
  second one, because `bootstrapOwner` refuses to run once any user exists. A
  member below owner cannot reach this path from either end, because they
  cannot issue an invitation in the first place. This closes what would
  otherwise be a foundational gap:
  without it, anyone who could reach the server could sign up, create an
  organization, and become its owner, gaining `host.enroll` and
  `sshKey.manage` — root-equivalent access to every host that organization
  ever enrolls — regardless of how correct the capability matrix and
  organization-scoping below are, because both assume members are vetted.
  Closing sign-up is necessary but not sufficient: the organization-creation
  half of that same chain is a separate control, closed separately in the next
  bullet, and it was reachable by any authenticated session — an invited
  viewer included — until it was.
- **Organization creation is closed on every mounted instance.** better-auth's
  organization plugin exposes `POST /organization/create`, which gates on a
  valid session alone and then writes the caller a member row carrying
  `creatorRole` — `owner` here — and makes that organization active on their
  existing session. No organization permission can gate it, because the caller
  is not yet in an organization when it runs: the empty `operatorRole` and
  `viewerRole` definitions that correctly refuse `update-member-role`,
  `remove-member`, `update`, and `delete` have nothing to bind to on this one.
  Left at better-auth's default it is a one-request path from any authenticated
  session to the owner role and the full capability set, which would make the
  role model advisory rather than a ceiling and hand the escalated user
  `member.manage` in an organization of their own — an unbounded account
  factory defeating closed registration from the other side.
  `allowUserToCreateOrganization` is therefore set from
  `CreateAuthOptions.allowOrganizationCreation`, which defaults to denied, so
  both the mounted `auth` and the `signupAuth` used for invitation acceptance
  refuse it. Only the non-mounted instance built by the bootstrap CLI opts in,
  exactly as only that instance lifts `disableSignUp` — the first organization
  is created by a process the operator runs, never over HTTP.
  `apps/server/src/organization-creation.test.ts` proves it against the
  production shape: it signs a user in, asserts the create is refused, and
  asserts the user still cannot reach a capability-gated procedure afterwards,
  because the refusal only matters if the escalation it prevents is gone too.
- **One origin allowlist, honoured by both layers.** `ALLOWED_ORIGINS` is the
  deployment's CORS allowlist and is also passed to better-auth as
  `trustedOrigins`. `requireSameOrigin` runs on `*` and so refuses a
  state-changing request from an undeclared origin before better-auth sees it;
  better-auth's own check is what stands behind that, for a route reached by
  some future mount that does not sit under the middleware, and it is the
  layer that governs the library's own notion of a trusted origin as its route
  table changes. `advanced.disableOriginCheck` is set to `false` explicitly
  rather than left to default, because better-auth's default disables the
  check whenever it detects a test environment: left alone, the entire server
  suite exercises a configuration no deployment runs.
  `apps/server/src/auth-origin.test.ts` proves an undeclared origin is refused
  and a declared one is not, so neither half can be removed silently. Widening
  `ALLOWED_ORIGINS` now widens both layers at once — that is the point, and it
  is also the reason not to put anything in it that is not a dashboard the
  operator controls.
- **Out-of-band host key verification.** Enrollment requires the operator to
  supply the host's expected SSH host key fingerprint in advance; the control
  plane refuses to trust a host whose presented key does not match, closing
  the on-path MITM window that trust-on-first-use would leave open. This holds
  identically for hosts reached over a private tailnet: the fingerprint is
  required and checked there too. A tailnet authenticates the *network peer*,
  not the SSH service the manager then speaks to, and it does not distinguish a
  reinstalled or substituted host from the original — so it narrows who can
  attempt the connection without establishing what answers it. Re-trusting a
  host after its key changes follows the same rule: the operator supplies the
  new fingerprint, the control plane reads the key the host presents, refuses
  one that does not match, and stores the key type the host presented.
- **Sealed secrets with rotation.** Private keys and other secrets are sealed
  with `libsodium` public-key sealed boxes, addressed by `keyId`. Exactly one
  key pair is active for sealing new secrets at a time (`SecretStore.activeKeyId`);
  older key pairs are retained only to open secrets already sealed under them,
  never to seal new ones. A key is rotated by introducing a new pair, pointing
  new seals at it, and retiring the old private key once nothing references it
  — without a flag day.
- **Organization-scoped data access.** Every repository method but `listIds` and the
  deployment-wide `processIdentity` and `updateState` repositories named below takes
  an organization scope as a required first argument, so the compiler rejects a
  call that omits one. Every read and write applies it at the query level, not
  as a filter after the fact; the one method with no rows to predicate,
  `host.repository.ts`'s `lockHost`, folds the organization id into its
  advisory lock key instead.
- **One named exception, kept out of actor reach.**
  `organization.repository.ts`'s `listIds` takes no scope, and no scope could
  be applied to it: it enumerates the global `organization` table, which
  carries no `organizationId` column to bind to. It exists so fleet-wide
  background work — the notification retention sweep — can iterate tenants and
  then call organization-scoped methods for each. Its safety rests on reach
  rather than on a predicate: it returns organization ids and nothing else, its
  only caller is the worker's cleanup handler, and it is reachable from no
  router and from no other actor-facing path. Exposing it to an actor would
  disclose the existence of every tenant to any one of them, so it must stay
  the only exception that reaches tenant data and must never gain an
  actor-facing caller. The deployment-wide repositories below reach none.
- **Two deployment-wide tables, holding nothing a tenant owns.**
  `processIdentity` and `updateState` carry no `organizationId`, and their
  repositories take no scope, because what they record belongs to the
  deployment rather than to any organization: which build and schema each
  daemon runs, and what the release check last found. They are not exceptions
  to the rule above in the sense `listIds` is — they reach no tenant's rows at
  all. Neither may gain a column naming an organization or anything
  an organization owns.
- **Capability-gated privileged operations.** Host enrollment, provisioning,
  and removal all check the caller's role against an explicit capability
  matrix before touching data or contacting a host.
- **Removing a member ends their access at once.** An owner removes a member
  through `member.remove`, which refuses the last owner, an owner removing
  themselves, and an owner who was removed while the request waited. It cancels
  the invitations the removed member still had pending, and accepting an
  invitation is refused once its inviter is no longer a member, so a removed
  owner cannot come back through one. What ends access is the request context:
  from the next request on, it refuses any session whose active organization
  holds no member row for that user. After the removal commits, better-auth
  deletes the person's account when they belong to no other organization, or
  otherwise revokes their sessions in this one. If that step fails it is
  reported, not retried, and the leftover session can still reach
  `get-session` and the avatar and item-icon proxies until it expires, but no
  tRPC procedure. `apps/server/src/members.test.ts` proves the removed
  member's session is refused on its next request.
- **Serialized provisioning with a bounded-lease claim.** `provision` reads
  the host once, unlocked, to decide whether an attempt is worth starting at
  all (already-provisioning, missing ssh key, missing trusted fingerprint);
  the claim itself then takes the per-host advisory lock and updates the row
  in a single statement conditioned on the status that unlocked read last
  observed, so two concurrent claims cannot both win even though the
  deciding read happened before the lock was taken. `remove` takes the same
  lock first and only then reads and mutates the row, so a delete cannot race
  a provisioning claim. A claim older than the provisioning lease
  (`PROVISIONING_LEASE_MS`, currently 10 minutes) is treated as abandoned and
  may be reclaimed or the host deleted; reclaiming one is itself audited. The
  lease comfortably outlasts a single attempt's bounded worst-case runtime —
  a 10-second connect plus eight 15-second remote steps and one 180-second
  binary download, each bounded end-to-end including channel acquisition (see
  `packages/transport/src/ssh/connection.ts`), for about 310 seconds against
  a 600-second lease. A row can no longer sit in `provisioning` status with
  no attempt id or claim timestamp: a database check constraint
  (`host_provisioning_requires_lease`) requires both whenever status is
  `provisioning`, and the recovery path treats a missing claim timestamp as
  stale defensively, in case a row somehow reaches that state by any other
  route.
- **Re-trust rejected while a provisioning claim is live.** Updating a host's
  trusted key fingerprint takes the same per-host advisory lock `provision`
  uses and, once it holds that lock, re-reads the host; if the host is still
  `provisioning` and that claim has not gone stale, the re-trust is rejected
  with `HostProvisioningInProgressError` rather than allowed to land. This
  closes the window between a provisioning claim committing and the
  connection it authorizes actually starting: an in-flight attempt keeps
  using the fingerprint it read at claim time, and an operator revoking that
  fingerprint during the attempt is told the attempt is in progress instead
  of having the revocation silently overtaken by a connection already in
  motion. The rejection holds for as long as the claim stays non-stale
  (`PROVISIONING_LEASE_MS`, 10 minutes) — comfortably longer than an attempt's
  ~310-second bounded worst case, so a genuinely live attempt cannot outlive
  this protection under normal operation. A re-trust attempted before the
  claim is taken, or after the attempt has finalized (success or error) or
  its claim has gone stale, is allowed to proceed.
- **Audited enrollment with attribution surviving member deletion.** Enrollment,
  provisioning, and removal are recorded as audit events carrying both the
  actor's id and a non-blank actor label captured at the time of the action.
  If the member is later deleted, the foreign key is nulled but the label
  remains — an ordinary column, not enforced immutable by the database — so
  the record of who performed the action is not silently erased by that
  deletion. See **Known limitations** for what this attribution does not yet
  guarantee.

## Known limitations

- **A managed host holds the Minecraft refresh token for the account running on
  it.** The client persists its own session cache beside its working directory —
  which is the instance's own `0700` directory, so the cache is per-instance
  rather than shared. It uses one of two files, `SessionCache.db` (a serialized
  form) or `SessionCache.ini` (plaintext, one line per account ending in the
  refresh token); the shipped client reads both, so treat either as sensitive.
  The control plane deliberately does not custody the token: moving it into the
  database would leave it plaintext in the running process anyway, while
  permanently diverging from upstream's cache handling. A compromised host yields
  that account's Microsoft refresh token, and hosts should not be shared across
  trust boundaries an operator cares about keeping separate.
- **Instances on one host share a user, so their isolation rests entirely on
  systemd.** Every instance runs as the connecting account, and identical
  ownership makes `0700`/`0600` no barrier between siblings. The units therefore hide the home
  directory behind a tmpfs and bind back only the instance's own directory, so
  an instance cannot see another's Microsoft session cache at all. That holds
  only where the host's systemd applies it — see the next point — and where it
  does not, one instance can read every other's files.
- **systemd's filesystem hardening may be silently discarded.** The instance
  unit asks for `ProtectSystem=strict`, `PrivateTmp` and a `ReadWritePaths=`
  scoped to its own directory. Those directives need a
  mount namespace, and a systemd user manager that cannot set one up ignores
  them without logging anything. Whether it can depends on the host, not on the
  unit: the same systemd version was measured enforcing them on one machine and
  discarding them on another, so the version alone does not tell you, and
  nothing here measures it. Where they are discarded, an instance is confined
  only by POSIX ownership — which, per the point above, does not separate it
  from its siblings. `NoNewPrivileges=yes`, `UMask=0077` and the exit-code
  restart policy need no namespace and apply either way.
- **Signing in to Microsoft runs under its own unit, with the same
  restrictions.** Reading the device code needs the client's output, which the
  manager takes from a file inside the instance's directory rather than by
  launching the client outside systemd. Sign-in is therefore confined exactly as
  a running instance is, and is stopped by unit name rather than by matching
  process names.
- **Drift reporting discloses other organizations' instance ids on a shared
  host.** Reconciliation enumerates the manager's unit files in
  `~/.config/systemd/user` and reports any the requesting organization does not
  define. That listing is host-wide, while the expected set is organization-
  scoped, so if two organizations enroll the *same* machine, each sees the
  other's sleep timers — and therefore the other's instance ids — reported as
  unexpected drift. The enumeration cannot distinguish another organization's
  live timer from a leftover of one's own deleted instance, which is the case it
  exists to catch. This is consistent with the deployment model above:
  organizations are an administrative partition, not a customer-isolation
  boundary. Do not enroll one host into two organizations that should not see
  each other.

- **Per-host SSH identities are an operator recommendation, not an enforced
  property.** `host.sshKeyId` is a plain nullable foreign key; the only
  uniqueness constraint on `host` is `(organizationId, name)`. Nothing today
  prevents provisioning many hosts from the same SSH key pair. Operators
  SHOULD provision a dedicated key per host to limit the blast radius of a
  single leaked key, but the system does not require, verify, or warn about
  reuse.
- **A stalled provisioning claim is recoverable only after its lease
  expires, not immediately.** If the application process dies mid-provision,
  the affected host is unavailable for a new `provision` or a `remove` call
  until `PROVISIONING_LEASE_MS` (currently 10 minutes) has elapsed since the
  claim. This bounds what was previously an unbounded, permanent lockout to a
  bounded wait — it does not eliminate the wait.
- **Actor label provenance is not verified at the domain layer.**
  `host.controller.ts` and `audit.repository.ts` accept whatever `actorLabel`
  string arrives on `ActorContext`; they reject only a blank one. Nothing at
  this layer confirms the label actually corresponds to the authenticated
  `actorId` it is paired with — a caller that constructs `ActorContext`
  directly (as every test in this codebase does) can put any string in that
  field. The HTTP API is what enforces this in practice: its request context
  derives `actorLabel` from the authenticated session's email, never from a
  client-supplied field, and this is proven by a test that submits a
  client-supplied `actorLabel` in both the request body and a header and
  asserts the persisted label is the session's email regardless. The gap
  above is scoped to the domain layer's own defenses, not the shipped API.
- **`sshKeyId` is not re-read under the provisioning lock, unlike the host key
  fingerprint.** `provision` re-reads `hostKeyFingerprint` after acquiring the
  per-host advisory lock, so a concurrent re-trust cannot cause a connection
  to proceed on a key that has just been revoked. It does not do the same for
  `sshKeyId`, which remains a generically mutable column. No current code
  path mutates a host's `sshKeyId` after creation, so this is latent rather
  than exploitable today. Any future feature that allows changing a host's
  SSH key must apply the same lock-then-reread treatment to `sshKeyId`, or a
  concurrent key change could swap the credential used for a connection whose
  fingerprint check has already passed.
- **Only the better-auth routes the dashboard calls are mounted.** `auth-routes.ts`
  names five, each with its method: `sign-in/email`, `sign-out`, `get-session`,
  `organization/list` and `organization/set-active`. Every other path under
  `/api/auth` answers 404 before better-auth sees it, which
  `auth-routes.wiring.test.ts` proves against the server `bootstrap.ts` builds.
  The library's full route table carries better-auth's own authorization, not
  this system's: the capability matrix in `authz.ts` governs `/trpc/*` alone.
  While everything was
  mounted, a viewer could read a pending invitation's id from
  `organization/list-invitations` or `organization/get-full-organization`, and
  `member.acceptInvitation` accepts on that id alone, so any member could take
  an owner invitation. Anything else the dashboard needs from better-auth goes
  through a tRPC procedure that calls `auth.api` in-process after
  `requireCapability`, never through a new entry in that list. Upgrading
  better-auth changes what those five paths do, so re-read them on an upgrade.
- **Invitations are not emailed.** `member.invite` creates the invitation
  record and the dashboard shows the inviting owner a link to it, but no mailer
  is configured — the owner sends that link to the invitee out of band. Anyone
  holding the link can accept it until it is accepted, cancelled or expired, so
  an owner should cancel one that went to the wrong place.
  Wiring an email delivery step is future work, not a current control gap:
  the invitation's authorization (who may create one, what it can accept)
  does not depend on how it is delivered.
- **An existing account cannot be invited into a second organization.**
  Accepting an invitation creates the account, so an invitation to an email
  that already has one here fails with "This email already has an account
  here." A member removed from their only organization has their account
  deleted, so they can be invited back; someone who still belongs to another
  organization cannot. An accept refused after it created the account, because
  the invitation was cancelled or its inviter removed mid-accept, deletes that
  account again. Only an unexpected failure after sign-up can still leave an
  account with no membership, whose email then stays uninvitable until an
  operator deletes it from the database.
- **Audit records are not tamper-evident.** Audit events live in the same
  Postgres database the application itself can write to. An attacker with
  application-level or database-level control can alter or delete audit
  history along with everything else. Exporting audit events to append-only,
  externally-verifiable storage is future work, not a current control.
- **Sealed secrets are only as safe as the running process.** The keys used to
  open sealed secrets are held in the application's environment. This protects
  secrets at rest in the database and in backups, but offers no additional
  barrier once the application process itself is compromised — an attacker
  with code execution in that process can open anything the process can.
- **The control-plane image's `libssl3` carries six known CVEs the base
  image has not yet patched.** `gcr.io/distroless/nodejs22-debian12` ships
  `libssl3 3.0.18-1~deb12u2`; Debian has released fixed packages
  (`3.0.19-1~deb12u2`, `3.0.20-1~deb12u2`) but the published distroless image
  has not been rebuilt against them, and distroless ships no package manager
  to patch it ourselves. These are tracked with expiring entries in
  `.trivyignore` (`CVE-2026-31789`, `CVE-2026-28387` through `-28390`,
  `CVE-2026-45447`), not a blanket `ignore-unfixed`, so the scan gate fails
  loudly again once the ignores expire rather than staying silently green.

## Gate: three controls the HTTP API had to implement, and does

These three were deferred to the HTTP API layer while it was still future
work. That API has shipped, and all three hold today against real server
code, each with the test this section demanded. The section stays because the
requirement did not expire with the deferral: **none of the following may be
skipped, watered down, or removed by a later change.** Each MUST hold, and
each MUST stay proven by a test against real server code — not by a comment,
a TODO, or a mention in a design document. The named test is the one that
proves it now; if you replace it, replace it with something that proves the
same thing:

- **`actorLabel` MUST be derived server-side from the authenticated user,
  never accepted from the client and never defaulted.** The router MUST
  populate `ActorContext.actorLabel` from the session the request
  authenticated with (for example, the user's email on that session) before
  calling into `host.controller.ts`. It MUST NOT read a label from the
  request body, query, or headers, and MUST NOT substitute a placeholder when
  an actor id is present — the repository layer already throws in that case,
  and the API must not paper over the throw by inventing a label.
  **Required test:** send a request with a client-supplied field shaped like
  an actor label (in the body or a header) and assert that the label
  actually persisted on the resulting `host.hostKeyTrustedByLabel` or
  `auditEvent.actorLabel` row is the session-derived value, not the
  client-supplied one — proving a client cannot make its own label reach
  host trust or audit records.
- **The secret store MUST be constructed, and startup MUST fail if it
  rejects, before the server listens.** The bootstrap path MUST call
  `await createSecretStore(env.SEALBOX_KEYS)` and MUST NOT call
  `listen()`/start accepting connections until that call has resolved.
  If it rejects, startup MUST fail (a thrown error or non-zero exit), not a
  logged warning followed by a running server.
  **Required test:** start the server with a `SEALBOX_KEYS` value containing
  a mismatched key pair (a `keyId` whose public and private halves do not
  correspond) and assert the process fails to start, rather than starting
  and serving requests against a secret store that cannot actually open what
  it seals.
- **No error serializer may reflect internal error fields to the client.**
  `FingerprintMismatchError` was deliberately stripped of the presented and
  expected fingerprint values (see `host.controller.ts`) so that an operator
  cannot submit a dummy fingerprint, read the real one back from the failure,
  and resubmit it — which would collapse out-of-band verification into
  two-request trust-on-first-use. The HTTP error handler MUST map known
  domain errors to a stable code and a generic message, and MUST NOT
  serialize an error's raw `message`, `stack`, or `cause` verbatim into the
  response for errors that intentionally withhold detail.
  **Required test:** trigger a host-key fingerprint mismatch through the HTTP
  layer and assert the JSON response contains neither the presented nor the
  expected fingerprint (nor a stack trace), mirroring the existing unit test
  that asserts this at the controller layer today.

All three pass today: `apps/server/src/actor-label.test.ts`,
`apps/server/src/bootstrap.test.ts` and
`apps/server/src/error-serialization.test.ts` respectively. A change that
makes any of them fail is a change that reopens a control this project
committed to closing, not a test that needs relaxing.

## Reporting a vulnerability

If you find a security issue in open-mcc-manager, please report it privately
rather than opening a public issue — email the maintainer or use your
repository host's private vulnerability reporting feature. Include enough
detail to reproduce the issue; you can expect an acknowledgement and a plan for
remediation before any public disclosure.
