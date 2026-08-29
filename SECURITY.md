# Security

## Trust boundary

The control plane holds credentials — SSH private keys and, through them, Docker
daemon access — that grant root-equivalent control over every host it manages.
A compromise of the control plane (its database, its application process, or an
operator's session) is a compromise of the entire fleet: an attacker who reaches
the control plane can act as root on any managed VPS.

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

- **Per-host SSH identities.** Each host is provisioned with its own SSH key
  pair rather than a shared credential, limiting the blast radius of a single
  leaked key.
- **Out-of-band host key verification.** Enrollment requires the operator to
  supply the host's expected SSH host key fingerprint in advance; the control
  plane refuses to trust a host whose presented key does not match, closing
  the on-path MITM window that trust-on-first-use would leave open.
- **Sealed secrets with rotation.** Private keys and other secrets are sealed
  with `libsodium` public-key sealed boxes. Multiple key pairs may be active at
  once, identified by `keyId`, so a new key can be introduced and made active
  for new secrets while older secrets remain readable under their original
  key — supporting rotation without a flag day.
- **Organization-scoped data access.** Every repository read and write is
  scoped by organization id at the query level, not filtered after the fact.
- **Capability-gated privileged operations.** Host enrollment, provisioning,
  and removal all check the caller's role against an explicit capability
  matrix before touching data or contacting a host.
- **Audited enrollment with attribution surviving member deletion.** Enrollment,
  provisioning, and removal are recorded as audit events carrying both the
  actor's id and an immutable, non-blank actor label captured at the time of
  the action. If the member is later deleted, the foreign key is nulled but the
  label remains, so the record of who performed the action is not silently
  erased.

## Known limitations

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
