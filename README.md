<img src="docs/assets/banner.png" alt="OpenMCC" width="100%">

# open-mcc-manager

A centralised control plane for managing Minecraft Console Client instances across a fleet of servers.

## Requirements

The control plane needs:

- Node 22
- pnpm 10.22
- Docker
- Postgres 17

Each host it manages needs:

- Debian 12 (Raspberry Pi OS on it too), Debian 13 or Ubuntu 24.04. Ubuntu is
  untested on a real Ubuntu host. Ubuntu 22.04 is refused: its Podman is older
  than 4.3.1 and lacks the log driver bots need.
- An x86_64 or aarch64 machine. CI runs the Podman runtime on x86_64 only inside
  sandbox containers; no real x86_64 host has run it yet.
- Rootless Podman 4.3.1 or later, cgroup v2, subordinate uid and gid ranges for
  the account, and overlay storage.
- systemd with the account's user manager and lingering on, and SSH. Live
  control also needs SSH port forwarding.

The manager signs in over SSH as one ordinary account and never gains root. It
refuses uid 0. When you enrol a host, the dashboard gives you a setup script to
run once with `sudo`, and **Check host** names anything still missing with the
command that fixes it. [SECURITY.md](./SECURITY.md) says what that account can
reach.

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

It builds the server and worker images and runs five services, each published on
the port its `.env` variable names:

- `postgres` — the persistent development database, `DEV_DB_PORT`.
- `postgres-test` — an ephemeral database, `TEST_DB_PORT`, that the test suite
  connects to. It has no volume and is not expected to survive a restart.
- `migrate` — a one-shot container that applies the schema to `postgres` and
  exits. `server` and `worker` both wait for it to complete successfully.
- `server` — the control plane, `SERVER_PORT`.
- `worker` — background delivery and scheduled work. It publishes no port.

The dashboard is not one of them; nothing in `docker/` builds or serves
`apps/web`. Run it from the checkout, against the `server` the stack started:

```bash
pnpm --filter @open-mcc/web dev
```

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
DATABASE_URL=postgres://postgres:postgres@localhost:25433/postgres \
  pnpm --filter @open-mcc/db db:migrate
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Those four are the gates, and CI runs the same ones. `pnpm lint` is more than a
formatter: it also runs the repository's own checkers over the whole tree, so a
failure there may name a type-policy or runtime-dependency rule rather than a
style one.

Skipping that step fails most of the suite with `relation "organization" does
not exist`; `packages/db`'s schema tests report the same cause as `table not
found: sshKey`.

`SEALBOX_KEYS` encrypts the SSH private keys the control plane stores, so it
has no safe default and `.env.example` deliberately refuses to boot. Generate
a real one:

```bash
pnpm --filter @open-mcc/server keys:generate k1
```

`docker/compose.dev.yml` — which only `pnpm dev:up` layers in — carries a working
key under the id `dev-insecure-publicly-known` so development starts a usable
server without generating anything. It is deliberately **not** in
`docker/compose.yml`, so no real deployment can pick it up, and the server logs a
warning if it ever starts with it. That key is in this repository and is
therefore public. Its id is deliberately
unmistakable and is stored with every row it encrypts, so
`select count(*) from "sshKey" where "privateKeyKeyId" = 'dev-insecure-publicly-known'`
tells you whether a database was ever written with it.

Registration is closed, so a fresh stack has no accounts. Create the first
owner against the compose database, using the same `BETTER_AUTH_SECRET` the
`server` service runs with, or its sessions will not verify:

```bash
DATABASE_URL=postgres://postgres:postgres@localhost:25432/open_mcc_manager \
BETTER_AUTH_SECRET=dev-only-secret-change-me-before-any-real-deploy \
SEALBOX_KEYS="dev-insecure-publicly-known:Am5fPqmntZmYRD3qh57huQfRy+oSfBgo1tzp8PNcNS8=:MDiplVb87qftrMZUimPXPEqL/CLTjlFUguzjwGwUgP0=" \
ALLOWED_ORIGINS=http://localhost:25173 \
BOOTSTRAP_OWNER_EMAIL=owner@example.com \
BOOTSTRAP_OWNER_PASSWORD='correct horse battery staple' \
BOOTSTRAP_OWNER_NAME=Owner BOOTSTRAP_ORG_NAME=Fleet BOOTSTRAP_ORG_SLUG=fleet \
  pnpm --filter @open-mcc/server bootstrap:owner
```

`ALLOWED_ORIGINS` is both this application's CORS allowlist and the origin list
better-auth trusts, so the dashboard's own origin (`WEB_PORT`) can authenticate
against the server (`SERVER_PORT`).

## Installing

On a machine with nothing but Docker and git:

```bash
sh -c "$(curl -fsSL https://raw.githubusercontent.com/thinesjs/open-mcc-manager/main/scripts/install.sh)"
```

Or, from inside a checkout:

```bash
sh scripts/install.sh
```

The same script serves both. It clones if it is not already in a checkout, builds
the control-plane image, generates a sealbox keypair, a session secret and a
database password, writes them to `.env` with mode `600`, and starts the stack on
free ports in the 25xxx block.

The stack it starts includes a Postgres of its own, from
`docker/compose.postgres.yml`, with no port published outside the stack.
`docker/compose.yml` carries no database, so a deployment that brings its own
leaves that file out and points `DATABASE_URL` at it.

That one-liner runs a script this project serves, so it is worth saying what you
are trusting and how to check it. Read it first if you would rather:

```bash
curl -fsSL https://raw.githubusercontent.com/thinesjs/open-mcc-manager/main/scripts/install.sh -o install.sh
less install.sh
sh install.sh
```

Use `sh -c "$(curl ...)"` rather than piping into `sh`. Piping leaves the script
itself on the installer's standard input, so any command that reads stdin would
consume the rest of it.

The generated `.env` pins `COMPOSE_PROJECT_NAME`. Without it, a later compose
command would resolve to a different project, create a second empty database
volume, migrate that one, and quietly orphan the real one.

Every later compose command for this install names the database overlay as well
as the base file:

```bash
docker compose --env-file .env -f docker/compose.yml -f docker/compose.postgres.yml up -d
```

Leave the overlay out and Postgres is no longer part of the stack:
`--remove-orphans` removes its container, and without that flag `server` and
`worker` stop waiting for a healthy database. Add `-f docker/compose.tailnet.yml`
after both files to reach hosts by MagicDNS name.

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

The control plane holds the SSH credentials for every host it manages, so a
compromise of the control plane is a compromise of the entire fleet. On every
host the manager works as the one account enrolled for it, inside that
account's home directory, and runs each bot in a rootless Podman container under
that account's systemd user manager. It never gains root. See
[SECURITY.md](./SECURITY.md) for the full trust boundary,
supported deployment model, current controls, and known limitations, and for
how to report a vulnerability.

## Licence and the client it manages

This project is licensed under the MIT Licence — see [LICENSE](./LICENSE).

It manages [Minecraft Console Client](https://github.com/MCCTeam/Minecraft-Console-Client),
which is a separate project under the CDDL-1.0. No client source code or
executable is included in this repository. Each host downloads the release binary directly from the
client's own GitHub releases, pinned to one version and verified against a
recorded SHA-256 before it runs, so the client reaches your hosts from
upstream rather than from this repository.

One test fixture holds a configuration document captured from a running
instance, so that the config parser and the drift comparison are exercised
against the real key surface. It carries the section and key structure and
representative values — some configured, some pinned by this project rather than
the client's own defaults — and none of the client's own explanatory text.

This is not an official Minecraft product. It is not approved by or associated
with Mojang or Microsoft. The
dashboard displays item renders and player-head avatars fetched from
third-party services at runtime; neither is bundled or redistributed here. See
[NOTICE](./NOTICE) for the notices this project's third-party material
requires.
