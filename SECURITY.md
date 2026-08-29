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
- **Serialized provisioning with a bounded-lease claim.** `provision` claims a
  host by recording an attempt id and a claim timestamp, conditional on the
  host's prior status still matching what was last observed; `remove` and a
  competing `provision` both take the same per-host advisory lock before
  reading or mutating the row, so a delete cannot race a provisioning claim
  and two claims cannot both win. A claim older than the provisioning lease
  (`PROVISIONING_LEASE_MS`, currently 5 minutes — comfortably longer than the
  120-second remote-exec timeout) is treated as abandoned and may be reclaimed
  or the host deleted; reclaiming one is itself audited.
- **Re-trust serialized against provisioning.** Updating a host's trusted key
  fingerprint takes the same per-host advisory lock `provision` uses, and
  commits the new trust tuple together with its audit event in one
  transaction, so a concurrent provisioning attempt cannot connect using a
  fingerprint that has just been revoked, nor can a re-trust land while a
  claim is being taken or finalized.
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
  field. Enforcing that the label is genuinely the acting user's own identity
  is the HTTP API's responsibility; see the gate below.
- **Until the HTTP API exists, nothing enforces server-side derivation of
  the actor label.** The requirement that `actorLabel` be derived from the
  authenticated session rather than accepted from a client currently has no
  code to enforce it, because there is no HTTP boundary yet for a client to
  submit it across. This is deliberate deferral, not an oversight, but it must
  not still be true once the API ships — see the gate below.
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

## Reporting a vulnerability

If you find a security issue in open-mcc-manager, please report it privately
rather than opening a public issue — email the maintainer or use your
repository host's private vulnerability reporting feature. Include enough
detail to reproduce the issue; you can expect an acknowledgement and a plan for
remediation before any public disclosure.
