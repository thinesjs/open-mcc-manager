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

```bash
pnpm install
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

## Security

The control plane holds credentials that grant root-equivalent access to every
host it manages, so a compromise of the control plane is a compromise of the
entire fleet — see [SECURITY.md](./SECURITY.md) for the full trust boundary,
supported deployment model, current controls, and known limitations, and for
how to report a vulnerability.
