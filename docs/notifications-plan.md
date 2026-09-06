# Stage 5 — Notifications

## What this has to do

Tell an operator, off the dashboard, when something needs them. Three delivery
channels: **Web Push**, **outbound webhook**, **Telegram**. Delivery must be
**queued and retried**, because the whole point is the message arriving when the
operator is not looking at the screen.

## What a deployment tool does, and what is worth taking

Read at `another checkout deployment tool`,
`packages/server/src/utils/notifications/` and `db/schema/notification.ts`.

Worth taking:

- One row per configured destination, with **per-event boolean columns** on that
  row (`appBuildError`, `databaseBackup`, …). Subscribing is a property of the
  destination, not a separate join table. Simple, and it reads well in a form.
- A separate table per provider holding that provider's own fields, related back
  to the destination row.
- A **"test connection"** endpoint per provider. An operator who cannot tell
  whether a webhook is wired up will assume the feature is broken.

Not worth taking, and the reason this plan exists:

- **Its notification subsystem has no queue and no retry.** `build-error.ts:41`
  loads the destination list and `await`s each provider call inline;
  `application.ts:238` awaits delivery in the middle of a deployment. Telegram
  failures are logged and dropped (`utils.ts:104`). If a webhook is down for ten
  seconds that notification is gone, with nothing recording the attempt. Note the
  narrower claim: a deployment tool *does* use BullMQ elsewhere (`apps/schedules`), just not
  for notifications.
- `notificationType` is a `pgEnum`. This repo does not use Postgres enums.
- Its provider tables carry no `organizationId` and store tokens and URLs in
  plaintext. Copy the shape, never the columns.

## The design

### Delivery is a job, never an inline call

`pg-boss` is already a dependency and already drives `host.teardown` through
`packages/core/src/job/job.queue.ts`. Notifications use the same path:

1. Something happens. The controller writes a `notification` row — the durable
   record of the event, independent of any channel.
2. For each enabled destination subscribed to that event, enqueue one
   `notification.deliver` job carrying `{ notificationId, destinationId }`.
   One job per destination, so a dead Telegram bot cannot hold up a webhook.
3. The worker delivers, and pg-boss owns the retry: `retryLimit`,
   `retryBackoff: true`. A job that exhausts its retries lands in the dead-letter
   queue rather than vanishing.
4. Each attempt writes a `notificationDelivery` row: destination, attempt number,
   outcome, HTTP status or error, timestamp. This is what the UI reads to say
   "last delivery failed", and what makes the retry visible rather than folklore.

Enqueue happens in the **same transaction** as the notification row, exactly as
`host.controller.ts` does it — `boss.send(queue, payload, { db: runner })`. If the
transaction rolls back, no job is left pointing at a row that does not exist.

### Delivery is two records, not one

One row per logical delivery, and one per attempt:

- `notificationDelivery` — one per `(organizationId, notificationId, destinationId)`.
  Its id is generated **in the notification transaction** and is the stable
  **idempotency key** sent to receivers as `Idempotency-Key`. A webhook receiver
  persists it and replays its previous result for a duplicate.
- `notificationDeliveryAttempt` — one row per attempt, with outcome, status code
  and a redacted error.

This matters because pg-boss is **at-least-once**: it invokes the handler and only
then marks the job complete, so a crash after the remote service accepted the
request causes a redelivery. The key must come from the logical delivery, never
from an attempt or a pg-boss job id. If an attempt number is needed, the worker
must ask for `JobWithMetadata` — a plain `Job` has no `retryCount`.

### One queue per provider, not one shared queue

A pg-boss worker defaults to batch size 1 and concurrency 1, and the existing
worker passes no options. A single `notification.deliver` queue would therefore
let one slow Telegram call block a webhook behind it. Use
`notification.deliver.webhook`, `.telegram` and `.webpush`, each with its own
concurrency and retry policy.

`deadLetter` is not automatic: the dead-letter queue must be created first, and
`createQueue` uses `ON CONFLICT DO NOTHING`, so changing a queue's options later
does **not** update it. Queue creation and migration has to be explicit.

### Which failures are permanent

Retrying a permanent failure burns the retry budget and delays nothing useful.
The classifier is per provider:

| Provider | Terminal | Retry |
| --- | --- | --- |
| Web Push | `404` and `410` (delete the subscription), `400`, `401`, `403`, `413` | `429`, 5xx, network, timeout |
| Telegram | `400`, `401`, `403` | `429` honouring `parameters.retry_after`, 5xx, network, timeout |
| Webhook | other 4xx | `408`, `429`, 5xx, network, timeout, honouring `Retry-After` |

Telegram reports failure in a `200` body, so the JSON `ok` and `error_code` must
be parsed — "did `fetch` throw" is not a classifier. A permanent failure marks the
destination unhealthy and waits for an operator, rather than retrying forever.

### Tables

**Every one of these carries `organizationId`**, with composite foreign keys, and
every repository method takes organization scope — that rule is unconditional in
AGENTS.md and the first draft of this plan broke it. Read state and Web Push
subscriptions key on `(organizationId, memberId)`, never the global user row. Job
payloads carry `{ organizationId, deliveryId }`.

- `notification` — the event. `kind` is an app-level union,
  **not** a Postgres enum. Carries a rendered title and body plus a `detail` jsonb
  so a channel can format richer output.
- `notificationRead` — per-user read state. The mobile app and the web bell both
  read this. This is the part that makes notifications a domain object rather
  than a fire-and-forget side effect.
- `notificationDestination` — one row per configured channel, with the per-event
  booleans and an `enabled` flag.
- `webhookDestination` / `telegramDestination` / `webPushSubscription` — the
  per-provider fields.
- `notificationSubscription` — one row per `(organizationId, destinationId, kind)`.
  Normalised rather than a boolean column per event, so a new event kind needs no
  migration and no API change.

### Secrets

The Telegram bot token is a secret and goes through the sealed store at
`packages/core/src/crypto/sealed-box.ts` (`seal`/`open`, as
`sshKey.privateKeyEncrypted` does), never a plaintext column. A webhook URL can
carry a token in its path, so the whole URL is sealed too. Web Push subscription
endpoints and auth secrets are sealed for the same reason — endpoint secrecy is
part of the Web Push security model.

A sealed URL still has to be shown back to the operator, so a destination carries
an operator-chosen **name** plus a sanitised display (`https://hooks.example.com/…`)
with userinfo, path, query and fragment stripped. Ciphertext and key id never
leave the server. An update that omits the URL keeps the stored one.

`packages/core/src/security/redact.ts` does not yet redact token-bearing URLs, so
delivery errors must not carry raw URLs or provider bodies until it does.

### Web Push

VAPID is the only push transport a lone self-hosted server can drive; APNs and
FCM need vendor credentials the operator will not have. The keypair is
**deployment environment configuration generated during setup**, not a database
row: a deployment-wide table would have no `organizationId` and there is no
exception to that rule worth taking here.

The web app has no service worker at all today (`apps/web/src/main.tsx` only
mounts React), so Web Push also needs registration, a permission prompt worth
showing, subscription renewal and removal, multi-device behaviour, and a secure
context. `webPushSubscription` stores the
browser's endpoint and keys per user per device. A `410 Gone` from the push
service means the subscription is dead and must be deleted, not retried — this is
the one case where a delivery failure must **not** be retried.

### Webhooks and egress

A webhook URL is operator-supplied, so this is deliberate outbound egress from
the control plane. Timeouts, a response size cap (live control already caps at
1 MiB for the same reason), a redirect limit and https-only are necessary but
**not sufficient** — none of them stops a URL resolving to loopback, a private
range, link-local, or a cloud metadata service, nor DNS rebinding between check
and connect, nor a redirect into any of those. Resolve and validate the address
of every connection *and* every redirect hop, deny reserved and private ranges by
default, and require an explicit deployment opt-in for private targets.

## Events worth raising

| Event | Why it matters |
| --- | --- |
| `instance.exited` | A non-zero exit the supervisor will not retry. The bot is off and staying off. |
| `instance.never_joined` | The unit is running and live control answers, but the client never reached the server. The failure that looks healthy. |
| `host.unreachable` | SSH or reconcile failed, so a whole host's fleet is unmanaged. Fires on transition, not per poll. |
| `instance.drift` | The host stopped matching the expected config. |
| `instance.needs_auth` | A Microsoft sign-in expired and the instance cannot start. |

## Settled after review

1. **Subscriptions are normalised**, not boolean columns. Five events already span
   different producers and each new one would otherwise cost a migration.
2. **Retention is 90 days** for notifications, read rows, deliveries and attempts,
   via an organization-scoped cleanup job. Never delete a notification while a
   delivery is queued, retrying, or held in the dead-letter queue.
3. **Dedupe ships in v1**: transition-only event creation plus a 15-minute cooldown
   on `(organizationId, subjectType, subjectId, kind)`, enforced transactionally.
   This is a separate concern from the delivery idempotency key.

## What blocks implementation

The largest gap is not in this design but underneath it: **the events have no
durable producers.** `host/health-poller.ts` logs a failure and returns an
in-memory list without recording a transition. Reconciliation is an on-demand
query that returns drift and persists no incident state. Nothing today can say
"this host *became* unreachable" or "this instance *started* drifting", which is
exactly what a notification needs. A background observer with durable transition
state has to exist first, or every event fires on a poll rather than on a change.

Also outstanding before code:

- No notification capability exists in `packages/contracts/src/authz.ts`, and new
  domain mutations need a controller capability check plus a transactional audit
  write.
- "Test connection" must go through the same queued path and expose a pollable
  result, or it becomes a second delivery implementation with different behaviour.
- The transactional-enqueue guarantee is real in pg-boss 12.30 but is currently
  only covered by a no-op test double. It needs one real integration test that
  proves a rolled-back transaction leaves no job row.
