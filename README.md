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

Start the stack with `docker compose -f docker/compose.yml up -d`. It builds
the control-plane image and runs four services:

- `postgres` — the persistent development database on port 5432.
- `postgres-test` — an ephemeral database on port 55432 that the test suite
  connects to. It has no volume and is not expected to survive a restart.
- `migrate` — a one-shot container that applies the schema to `postgres` and
  exits. `server` waits for it to complete successfully.
- `server` — the control plane on port 3000.

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
better-auth trusts, so the dashboard's dev origin (`http://localhost:5173`)
can authenticate against the dev server on `http://localhost:3000`.

## Security

The control plane holds credentials that grant root-equivalent access to every
host it manages, so a compromise of the control plane is a compromise of the
entire fleet — see [SECURITY.md](./SECURITY.md) for the full trust boundary,
supported deployment model, current controls, and known limitations, and for
how to report a vulnerability.
