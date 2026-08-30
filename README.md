# open-mcc-manager

A centralised control plane for managing Minecraft Console Client instances across multiple VPS hosts.

## Requirements

- Node 22
- pnpm 10.22
- Docker
- Postgres 17

## Development

Copy `.env.example` to `.env` and fill in the values — it documents every
variable the server and the test suite need, including `TEST_DATABASE_URL`
(the test suite needs Postgres for most of its tests). Start both databases
with `docker compose -f docker/compose.yml up -d`: `postgres` is the
persistent development database on port 5432, `postgres-test` is an
ephemeral database on port 55432 that the test suite connects to and that
is not expected to survive a restart.

Because `postgres-test` has no volume, it starts empty every time it is
recreated, so apply the schema to it before running the suite. The migration
entry point reads `DATABASE_URL` rather than `TEST_DATABASE_URL`, so point it
at the test database explicitly for that one command:

```bash
pnpm install
DATABASE_URL=postgres://postgres:postgres@localhost:55432/postgres \
  pnpm --filter @open-mcc/db db:migrate
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Skipping the migrate step fails the suite with `relation "organization" does
not exist`.

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

## Security

The control plane holds credentials that grant root-equivalent access to every
host it manages, so a compromise of the control plane is a compromise of the
entire fleet — see [SECURITY.md](./SECURITY.md) for the full trust boundary,
supported deployment model, current controls, and known limitations, and for
how to report a vulnerability.
