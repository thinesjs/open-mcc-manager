# open-mcc-manager

A centralised control plane for managing Minecraft Console Client instances across multiple VPS hosts.

## Requirements

- Node 22
- pnpm 10.22
- Docker
- Postgres 17

## Development

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
