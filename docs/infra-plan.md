# Splitting dev from production, and deploying to Kubernetes

Two jobs that share one root cause: `docker/compose.yml` is simultaneously the base file, the
thing dev runs, and the closest thing to a production deployment. Nothing in the repository
describes a production deploy that a stranger could run, and nothing describes the k3s target
at all.

## What is true today, read rather than assumed

- `compose.yml` bundles **postgres** with a host port binding and a `pgdata` volume, and every
  service is `build:` from source. So it cannot be run from published images, and a real
  deployment with an external database has to edit it.
- `compose.dev.yml` adds only two things: a `postgres-test` database and the dev
  `BETTER_AUTH_SECRET` / `SEALBOX_KEYS`. So the dev overlay is thin and the base file is
  carrying the dev-shaped decisions.
- **The `migrate` service runs `target: build`.** That is the full toolchain stage — pnpm, all
  sources, every devDependency — so migrations ship a fat image while `server` and `worker`
  ship distroless. This is the one that has already cost real time: a stale `migrate` image
  reports "corrupted migrations: … is missing" and takes the whole server down with it.
- `server` and `worker` are esbuild bundles over a pruned `pnpm deploy` tree, with an explicit
  `--external:` list per image, and `scripts/check-runtime-deps.mjs` asserts every external is
  in `prune-deploy.mjs`'s `runtimeRoots`. That check exists because getting it wrong
  crash-looped both containers while every unit test stayed green.

### The detail that decides how migrations get packaged

`packages/db/src/migrator.ts` resolves its SQL like this:

```
MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations")
```

It is **relative to the module's own location**, so bundling changes where it looks. A bundle at
`/app/migrate.mjs` would search `/migrations`. That gives a free answer with no source change:
**bundle to `/app/db/migrate.mjs` and copy the SQL to `/app/migrations`**, so `..` lands exactly
where the existing code already looks. No env var, no code change, nothing to keep in sync.

## Part one: the compose split

- **`compose.yml` becomes production-shaped.** No bundled database, no dev secret, no host port
  bindings beyond the one the reverse proxy needs. Services reference **images by tag** with a
  `build:` block still present so a self-hoster can build locally, and `DATABASE_URL` comes
  from the environment rather than being assembled from a bundled postgres service name.
- **`compose.dev.yml` takes everything dev-shaped**: the bundled `postgres`, `postgres-test`,
  the publicly known dev keys, the host port bindings, and `build:` overrides. `pnpm dev:up`
  keeps working exactly as it does now, because it already composes both files.
- **`compose.prod.yml` is not created.** A base file that is already production-shaped plus a
  dev overlay is one file fewer to keep honest than three files where the base means nothing.
  The rule stays the one the owner asked for — dev is suffixed and separate — it is just
  satisfied by making the unsuffixed file the real one.

## Part two: a migrate image that is not the toolchain

A third Dockerfile stage, `migrate`, built the same way the other two are: esbuild
`packages/db/src/migrate.ts` into the pruned `/out` tree, distroless runtime, non-root.

Two things this must not get wrong:

- **The SQL files must land at `/app/migrations`** for the reason above, and a test has to prove
  the packaged image actually finds them rather than trusting the path arithmetic.
- **The drift check needs no edit, and it is worth saying so precisely** so nobody goes hunting
  for work that is not there. `check-runtime-deps.mjs` does not hold a hand-maintained list: it
  regex-scans `--external:` out of each Dockerfile's text and compares against the
  `runtimeRoots` block it reads out of `prune-deploy.mjs`. Its `DOCKERFILES` array already
  contains `docker/server/Dockerfile`, and the migrate stage's whole import graph is
  `kysely` and `pg` — both already runtime roots, both already shipped for server and worker.
  So a new stage **inside that same Dockerfile** is covered for free. The only edit that would
  ever be needed is adding a path to `DOCKERFILES` if migrate became its own Dockerfile file,
  and that is a reason to keep it in the existing one.

## Part three: the k3s deployment

The target cluster's conventions, read from it rather than invented:

- **ArgoCD app-of-apps.** A single `root` Application watches `argocd/apps` with
  `directory.recurse` and `automated: { prune: true, selfHeal: true }`. So open-mcc registers by
  adding **one file** under `argocd/apps`, and `root.yaml` is never touched.
- **Plain Kustomize per app** at `manifests/<app>/kustomization.yaml`, listing resources
  explicitly rather than globbing.
- **sealed-secrets**, with `.plain.yaml` and `.sealed.yaml` committed side by side.
- **CNPG** is already an app, so Postgres is a `Cluster`, not a Deployment. The bundled postgres
  container does not cross into Kubernetes at all.
- **ArgoCD Image Updater** is deployed, so tags are advanced by annotation rather than pinned by
  hand.

### Two Applications, not one, and this is the part that would have deadlocked

The obvious shape — one Application holding the CNPG `Cluster` and a `PreSync` migrate hook —
**cannot ever complete its first sync.** Argo CD finishes the whole PreSync phase before the
Sync phase applies any ordinary resource, and sync waves only order resources *within* a phase.
So on a cold cluster the migrate hook runs before the `Cluster` exists, fails for want of a
database, and blocks the Sync phase that would have created the `Cluster`. Nothing in that
Application can heal it. Making the `Cluster` a PreSync hook at an earlier wave does not rescue
it either: no custom health check is registered for `postgresql.cnpg.io/Cluster` in this
cluster, so Argo CD calls an unrecognised CRD Healthy the moment apply succeeds and advances to
the migrate wave before CNPG has bootstrapped or generated the app secret. Same race, narrower
window.

The cluster already runs the right answer in production: `agentbot` keeps its database and
secrets in `agentbot-dev-extras` (path `manifests/agentbot-dev`) and its workload in a separate
Application. So:

- **`manifests/open-mcc-db/`** + `argocd/apps/open-mcc-db.yaml` — the namespace and the CNPG
  `Cluster`. That is all: nothing here needs a database to exist, and nothing here is read by
  the workload.
- **`manifests/open-mcc/`** + `argocd/apps/open-mcc.yaml` — a `Deployment` for the server behind
  a `Service`, a `Deployment` for the worker with no Service, an `Ingress`, a `ConfigMap`, the
  two sealed secrets, and the `PreSync` migrate `Job`.

The sealed secrets live with the workload, not with the database, because `SEALBOX_KEYS` and
`BETTER_AUTH_SECRET` have nothing to do with Postgres — they are read by the server and worker
pods and by nothing else. Putting them in the database Application would have separated them
from the only things that `secretKeyRef` them.

**Ingress is a plain `networking.k8s.io/v1 Ingress`, not a traefik `IngressRoute`.** This is
what the cluster actually does: fifteen manifests use plain `Ingress` with
`ingressClassName: traefik`, a `cert-manager.io/cluster-issuer` annotation,
`traefik.ingress.kubernetes.io/router.entrypoints: websecure`, and a `spec.tls[].secretName`.
There is not one standalone `Certificate` resource in the whole repository — cert-manager's
ingress-shim creates them from the annotation. `IngressRoute` appears exactly twice, both in a
`block-internal.yaml`, both as a secondary higher-priority rule layered over a base `Ingress`
to 404 an internal path, and both using traefik's own `certResolver` rather than cert-manager.
So there is no precedent for `IngressRoute` as primary ingress, and using one would have been
inventing a pattern while claiming to follow the cluster.

First bring-up is: sync the db Application, confirm the `Cluster` is healthy, then onboard the
app Application. Every later sync is unaffected, because the `Cluster` already exists.

**The migration runs as an ArgoCD `PreSync` hook `Job`**, not an init container and not a manual
step — the only placement that guarantees the schema is migrated *before* the new pods roll,
which is exactly the failure that has already bitten in compose. Three apps in this cluster
already do it this way.

Its cleanup is **`argocd.argoproj.io/hook-delete-policy: BeforeHookCreation,HookSucceeded`**, not
`ttlSecondsAfterFinished`, and the reason is correctness rather than house style: Jobs are
immutable, so if a completed Job is still present when the next sync applies a Job of the same
name, the apply fails. `BeforeHookCreation` removes the old one first, `HookSucceeded` clears up
after success, and neither depends on the k8s TTL controller being enabled or on timing.

**As defence in depth, `packages/db/src/migrate.ts` gains a short connect-retry loop.** Today a
single failed `pg` connection is fatal. The Application split is what removes the deadlock; the
retry only softens a cold start where the database is up but not yet accepting connections.

**The retry must be bounded** — a maximum attempt count or total elapsed time, never an open
loop. A genuinely wrong `DATABASE_URL` has to fail the PreSync hook in finite time with our own
message, rather than hanging until `activeDeadlineSeconds` or a pod eviction reports something
far less legible. An unbounded retry would turn a five-second configuration error into a
mystery.

### Secrets, and one that is not a secret we hold

**Sealed:** `SEALBOX_KEYS` and `BETTER_AUTH_SECRET`. Those two only. The dev values in
`compose.dev.yml` are publicly known and must never appear in a manifest.

**The database credential: this needs deciding, and an earlier draft of this plan got it
wrong.** That draft said CNPG's operator generates the app-user Secret so there is nothing for a
human to encrypt, and that `DATABASE_URL` should come from
`secretKeyRef: { name: open-mcc-pg-app, key: uri }`. **That is not how this cluster works.**
Reading it rather than reasoning about it: `manifests/agentbot-dev/` seals a
`SealedSecret` named `agentbot-pg-app` carrying `username` and `password`, and that is exactly
what its `Cluster`'s `bootstrap.initdb.secret.name` points at. Its application's
`DATABASE_URL` is a separate sealed key in `agentbot-secret`. So in this cluster the credential
**is** supplied and sealed by hand, and nothing references a generated `uri`.

Both shapes are valid CNPG. The choice is real:

- **Follow the convention.** Seal `open-mcc-pg-app` with `username` and `password` for
  `initdb.secret.name`, and seal `DATABASE_URL` alongside the other two app secrets. Matches
  every other app here. Cost: the password exists in two sealed secrets and has to be kept in
  step by hand, which is a drift waiting to happen.
- **Let CNPG own it.** Omit `initdb.secret.name`, let the operator generate `<cluster>-app`, and
  `secretKeyRef` its `uri` key. One source of truth, nothing to keep in step, no password
  written twice. Cost: it diverges from the cluster's convention, so a reader of the other apps
  will find this one different.

**Preference: let CNPG own it**, because a secret duplicated across two sealed files is a
correctness problem and "matches the neighbours" is a weaker reason than "cannot drift". But
this is a deliberate divergence rather than an accident, so it is written down here as one and
carries the reason, instead of being discovered later as an inconsistency.

### The config that is not secret but is not optional either

A plain `ConfigMap` beside the Deployment, because two of these will break the server on boot if
left to their defaults:

- **`ALLOWED_ORIGINS`** is `z.string().min(1)` with **no default** in `apps/server/src/env.ts`.
  Unset, the server dies on a Zod parse failure at startup.
- **`BETTER_AUTH_URL`** defaults to `http://localhost:3000`, which is simply wrong behind traefik
  and cert-manager — it would issue cookies against the wrong origin, quietly.
- **`OTEL_EXPORTER_OTLP_ENDPOINT: http://alloy.monitoring.svc.cluster.local:4318`**, added now
  and unused. Alloy is already deployed in the `monitoring` namespace with OTLP on 4318, and the
  apps already emitting to it do so with exactly this one key. Putting it in now makes the
  observability slice a pure application-code change with **zero manifest diff**.

**The worker is not horizontally scalable yet and the manifests must say so.** pg-boss gives at
least one delivery per job and the delivery job is idempotent per delivery row, but nothing in
this repository has been tested with two workers competing for the same queue. `replicas: 1`
with a comment-free but explicit single replica, and a note in the plan rather than a silent
assumption that scaling up is safe.

## The open question for review

**Should a Helm chart ship as well?** The argument for: an external self-hoster on Kubernetes
expects a chart, and Kustomize overlays are awkward to consume from outside the repository that
defines them. The argument against: the first-party stack is Kustomize throughout, so a chart
would be a second source of truth for the same deployment, maintained by nobody, and drifting
from the manifests that are actually exercised on every sync.

My inclination is **no chart for now** — ship the Kustomize base that the real cluster uses and
that is therefore continuously tested, and treat a chart as a request to satisfy when a
self-hoster actually asks. Shipping an untested chart is the same class of dishonesty as
offering a connector that cannot deliver. I would like this challenged rather than accepted.

## What proves it works

- `docker compose -f docker/compose.yml config` validates on its own, with no dev overlay, and
  `pnpm dev:up` still brings the stack up.
- A test in `scripts/`, the same shape as the existing `compose-secrets.test.ts`, asserting that
  **the production compose file contains no dev secret, no bundled database, and no `target:
  build`**. The point is that the split cannot silently rot back.
- The existing `check-runtime-deps.mjs` scan shown to cover the migrate stage too — **proved by
  deliberately removing one of its externals and watching the check fail**, the way the drift
  check was proved when it was added. No edit to that script; the point is to demonstrate the
  coverage is real rather than assumed, since Part two claims it comes for free.
- The migrate image run against a real database, proving it finds its SQL at the bundled path.
- `kustomize build manifests/open-mcc` succeeds, and the rendered output contains no plaintext
  secret — asserted, not eyeballed.
- The stack rebuilt and `docker ps` confirmed `Up` for server, worker and migrate, because a
  `build=0` has never meant the container started.

**Where these checks live, corrected after reading the workflow rather than assuming it.** This
plan first claimed three new CI steps were needed. Two of them already exist:

- The **runtime-deps removal proof** is already a unit test in `check-runtime-deps.test.ts`
  ("names a package that is externalised but would be deleted"), and `pnpm lint` — which CI
  runs — executes `check-runtime-deps.mjs` against the real Dockerfiles. So the drift check is
  covered twice over, in fixture form and against the actual files, with no new step.
- The **compose content invariants** ride `pnpm test` through `compose-secrets.test.ts`.

Only one genuinely new step was missing: **`docker compose config` validation**, which catches
a broken file or a bad interpolation that a content assertion reading the text cannot. It is now
two steps, one per file, so the production compose file is proved to stand alone with no dev
overlay. The `kustomize build` assertion waits until the manifests have a home.

The correction matters more than the saving: a plan that invents work is as misleading as one
that omits it.

## What this plan does not cover

**The web dashboard is out of scope, and that is pre-existing rather than an omission here.**
`docker/compose.yml` does not build or serve `apps/web` today and there is no Dockerfile for it
anywhere under `docker/`. Serving the dashboard is its own piece of work; this plan does not
quietly assume it away.
