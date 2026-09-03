# open-mcc-manager

A centralised control plane for managing Minecraft Console Client instances across multiple VPS hosts.

## Requirements

- Node 22
- pnpm 10.22
- Docker
- Postgres 17

## Development

Copy `.env.example` to `.env` and fill in the values. That file is read: the
test suites and `db:migrate` load the repository's `.env` through
`packages/config/load-env.mjs` before anything reads `process.env`. A variable
already exported in your shell always wins over the file, so CI — which sets
`TEST_DATABASE_URL` itself and has no `.env` — is unaffected, and you can still
point a single command at a different database by prefixing it.

Start the stack with `pnpm dev:up` (`pnpm dev:down` to stop, `pnpm dev:logs` to
follow). Use those rather than `docker compose` directly: the compose file lives
in `docker/`, so a bare `docker compose -f docker/compose.yml` takes `docker/` as
its project directory and reads `docker/.env`, which does not exist — every
`${...}` in the compose file then silently falls back to its default and the
ports in your `.env` are ignored. The scripts pass `--env-file .env` explicitly.

It builds the control-plane image and runs four services, each published on the
port its `.env` variable names:

- `postgres` — the persistent development database, `DEV_DB_PORT`.
- `postgres-test` — an ephemeral database, `TEST_DB_PORT`, that the test suite
  connects to. It has no volume and is not expected to survive a restart.
- `migrate` — a one-shot container that applies the schema to `postgres` and
  exits. `server` waits for it to complete successfully.
- `server` — the control plane, `SERVER_PORT`.

The defaults in `.env.example` sit in a 25xxx block chosen not to collide with
other local stacks. `ALLOWED_ORIGINS` must name the dashboard's own origin, and
`BETTER_AUTH_URL` the server's — change a port and those move with it, which
`scripts/env-example.test.ts` enforces.

`postgres-test` is deliberately left out of that migrate step. It has no
volume, so it comes back empty after any restart, while the one-shot `migrate`
container does not necessarily re-run — a compose-applied schema there would be
correct until the first restart and silently gone afterwards. Apply it
yourself instead, with the same command CI runs, so there is one path and not
two. The migration entry point reads `DATABASE_URL`, not `TEST_DATABASE_URL`,
so point it at the test database explicitly for that one command:

```bash
pnpm install
DATABASE_URL=postgres://postgres:postgres@localhost:55432/postgres \
  pnpm --filter @open-mcc/db db:migrate
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Skipping that step fails most of the suite with `relation "organization" does
not exist`; `packages/db`'s schema tests report the same cause as `table not
found: sshKey`.

`SEALBOX_KEYS` encrypts the SSH private keys the control plane stores, so it
has no safe default and `.env.example` deliberately refuses to boot. Generate
a real one:

```bash
pnpm --filter @open-mcc/server keys:generate k1
```

The compose stack ships a working key under the id
`dev-insecure-publicly-known` so `docker compose up` starts a usable server.
That key is in this repository and is therefore public. Its id is deliberately
unmistakable and is stored with every row it encrypts, so
`select count(*) from "sshKey" where "privateKeyKeyId" = 'dev-insecure-publicly-known'`
tells you whether a database was ever written with it.

Registration is closed, so a fresh stack has no accounts. Create the first
owner against the compose database, using the same `BETTER_AUTH_SECRET` the
`server` service runs with, or its sessions will not verify:

```bash
DATABASE_URL=postgres://postgres:postgres@localhost:5432/open_mcc_manager \
BETTER_AUTH_SECRET=dev-only-secret-change-me-before-any-real-deploy \
SEALBOX_KEYS="dev-insecure-publicly-known:Am5fPqmntZmYRD3qh57huQfRy+oSfBgo1tzp8PNcNS8=:MDiplVb87qftrMZUimPXPEqL/CLTjlFUguzjwGwUgP0=" \
ALLOWED_ORIGINS=http://localhost:5173 \
BOOTSTRAP_OWNER_EMAIL=owner@example.com \
BOOTSTRAP_OWNER_PASSWORD='correct horse battery staple' \
BOOTSTRAP_OWNER_NAME=Owner BOOTSTRAP_ORG_NAME=Fleet BOOTSTRAP_ORG_SLUG=fleet \
  pnpm --filter @open-mcc/server bootstrap:owner
```

`ALLOWED_ORIGINS` is both this application's CORS allowlist and the origin list
better-auth trusts, so the dashboard's own origin (`WEB_PORT`) can authenticate
against the server (`SERVER_PORT`).

## Installing

```bash
sh scripts/install.sh
```

Run it inside a checkout, or on a machine with only Docker and git — it clones,
builds the control-plane image, generates a sealbox keypair, a session secret and
a database password, writes them to `.env` with mode `600`, and starts the stack
on free ports in the 25xxx block.

It refuses rather than guessing in two cases. An existing `.env` is never
overwritten, because that file is the only copy of the sealbox private key. An
existing `<project>_pgdata` volume also stops the install: Postgres applies
`POSTGRES_PASSWORD` only when its volume is first created, so a freshly generated
password could not authenticate against a database that already exists.

**Back up `.env`.** `SEALBOX_KEYS` decrypts every stored SSH private key. Lose it
and the enrolled hosts have to be re-enrolled with new keys.

Development is the one case that does not need generated secrets: `pnpm dev:up`
layers `docker/compose.dev.yml` over the base file to supply a publicly known
key and session secret. Those values are deliberately not in `docker/compose.yml`,
so no real deployment can pick them up by accident, and the server logs a loud
warning if it ever starts with them.

## Network topologies

Hosts may sit on the public internet or on a private tailnet, and a single
deployment may mix the two. `host.hostname` is accepted as a free-form address
rather than matched against a public-DNS shape, so a public name, a public IP, a
tailnet CGNAT address and a MagicDNS name are all valid enrolments.
`packages/contracts/src/host.test.ts` pins that, because narrowing the field to
something DNS-shaped would silently drop tailnet support.

What the manager can reach depends on where it runs, not on what it accepts.
Measured from a container on the default bridge network, with Tailscale running
on the host:

| Address the host is enrolled under | Reachable from the manager container |
| --- | --- |
| `vps.example.com`, `203.0.113.10` | yes, no configuration |
| `100.101.102.103` (tailnet address) | yes, no configuration |
| `vps-1.tailnet.ts.net` (MagicDNS) | only with Tailscale's resolver |
| `vps-1` (bare MagicDNS) | only with Tailscale's resolver and search domain |

Tailnet addresses route without configuration because the container's traffic
leaves through the host's routing table, which Tailscale has already populated.
MagicDNS names do not resolve, because the container's resolver is Docker's, not
Tailscale's. Start the stack with `pnpm dev:up:tailnet` to point the server at
Tailscale's resolver on `100.100.100.100`; it requires `TAILNET_DNS_SUFFIX` and
refuses to start without it rather than leaving names quietly unresolvable.

Enrolling hosts by tailnet address avoids the resolver question entirely, and is
the simpler choice unless you need names.

## Security

The control plane holds credentials that grant root-equivalent access to every
host it manages, so a compromise of the control plane is a compromise of the
entire fleet — see [SECURITY.md](./SECURITY.md) for the full trust boundary,
supported deployment model, current controls, and known limitations, and for
how to report a vulnerability.
