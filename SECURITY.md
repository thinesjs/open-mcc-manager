# Security

## Trust boundary

The control plane holds credentials — SSH private keys and, through them, Docker
daemon access — that grant root-equivalent control over every host it manages.
A compromise of the control plane's application process, or of an
authenticated operator's session, is a compromise of the entire fleet: either
one lets an attacker act as root on any managed VPS. A compromise limited to
the database alone is narrower — private keys are stored sealed (see
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
authenticated API in place of raw SSH/Docker access, or a wholly separate
control-plane deployment per customer. Multi-tenant, hostile-tenant isolation is
not a goal of the current architecture.

## Current controls

- **Closed registration; accounts are provisioned, not self-served.** Public
  sign-up is disabled (`emailAndPassword.disableSignUp`) — the `/sign-up/email`
  endpoint refuses every request, regardless of caller, so nobody can create
  an account by simply reaching the server. The first owner is created by a
  deployment-time bootstrap (`pnpm --filter @open-mcc/server bootstrap:owner`,
  reading credentials from environment variables) that refuses to run if any
  user already exists in the database — a bootstrap that succeeds twice would
  be a backdoor, so this is enforced as a hard precondition, not a warning.
  Every subsequent member is added by invitation, issued by an existing
  member holding `member.manage` (owner only, per the capability matrix
  below); the invited person's account is created only as part of accepting
  that specific, pending invitation — never through the public endpoint —
  and lands in the inviting organization with the role the invitation named,
  never as owner. This closes what would otherwise be a foundational gap:
  without it, anyone who could reach the server could sign up, create an
  organization, and become its owner, gaining `host.enroll` and
  `sshKey.manage` — root-equivalent access to every host that organization
  ever enrolls — regardless of how correct the capability matrix and
  organization-scoping below are, because both assume members are vetted.
- **Out-of-band host key verification.** Enrollment requires the operator to
  supply the host's expected SSH host key fingerprint in advance; the control
  plane refuses to trust a host whose presented key does not match, closing
  the on-path MITM window that trust-on-first-use would leave open.
- **Sealed secrets with rotation.** Private keys and other secrets are sealed
  with `libsodium` public-key sealed boxes, addressed by `keyId`. Exactly one
  key pair is active for sealing new secrets at a time (`SecretStore.activeKeyId`);
  older key pairs are retained only to open secrets already sealed under them,
  never to seal new ones. A key is rotated by introducing a new pair, pointing
  new seals at it, and retiring the old private key once nothing references it
  — without a flag day.
- **Organization-scoped data access.** Every repository read and write is
  scoped by organization id at the query level, not filtered after the fact.
- **Capability-gated privileged operations.** Host enrollment, provisioning,
  and removal all check the caller's role against an explicit capability
  matrix before touching data or contacting a host.
- **Serialized provisioning with a bounded-lease claim.** `provision` reads
  the host once, unlocked, to decide whether an attempt is worth starting at
  all (already-provisioning, missing ssh key, missing trusted fingerprint);
  the claim itself then takes the per-host advisory lock and updates the row
  in a single statement conditioned on the status that unlocked read last
  observed, so two concurrent claims cannot both win even though the
  deciding read happened before the lock was taken. `remove` takes the same
  lock first and only then reads and mutates the row, so a delete cannot race
  a provisioning claim. A claim older than the provisioning lease
  (`PROVISIONING_LEASE_MS`, currently 5 minutes) is treated as abandoned and
  may be reclaimed or the host deleted; reclaiming one is itself audited. The
  lease comfortably outlasts a single attempt's bounded worst-case runtime —
  a 10-second connect plus two 120-second remote execs, each now bounded
  end-to-end including channel acquisition (see
  `packages/transport/src/ssh/connection.ts`), for about 250 seconds against
  a 300-second lease. A row can no longer sit in `provisioning` status with
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
  (`PROVISIONING_LEASE_MS`, 5 minutes) — comfortably longer than an attempt's
  ~250-second bounded worst case, so a genuinely live attempt cannot outlive
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
  until `PROVISIONING_LEASE_MS` (currently 5 minutes) has elapsed since the
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
- **Invitations are not emailed.** `member.invite` creates the invitation
  record and returns it to the inviting owner, but no mailer is configured —
  the owner must communicate the invitation id to the invitee out of band.
  Wiring an email delivery step is future work, not a current control gap:
  the invitation's authorization (who may create one, what it can accept)
  does not depend on how it is delivered.
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

## Gate: required before the HTTP API ships

Two controls were deferred to the future HTTP API layer. A deferral is only
legitimate if the work that lands the API actually implements it, so this
section exists to make each one a checkable requirement rather than a note
that can be lost. **None of the following may be skipped, watered down, or
left for a later task when the HTTP API is built.** Each MUST hold, and each
MUST be proven by a test against real server code — not by a comment, a
TODO, or a mention in a design document:

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

Until all three checks above pass against real server code, the HTTP API
must not be merged or deployed.

## Reporting a vulnerability

If you find a security issue in open-mcc-manager, please report it privately
rather than opening a public issue — email the maintainer or use your
repository host's private vulnerability reporting feature. Include enough
detail to reproduce the issue; you can expect an acknowledgement and a plan for
remediation before any public disclosure.
