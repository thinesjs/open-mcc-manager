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

- **There is no queue and no retry.** `sendBuildErrorNotifications` loads the
  destination list and `await`s each provider call inline inside a `try/catch`
  that logs. If a webhook is down for ten seconds, that notification is gone —
  nothing records that it was attempted, and nothing tries again.
- `notificationType` is a `pgEnum`. This repo does not use Postgres enums.

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

### Tables

- `notification` — the event. Organization-scoped. `kind` is an app-level union,
  **not** a Postgres enum. Carries a rendered title and body plus a `detail` jsonb
  so a channel can format richer output.
- `notificationRead` — per-user read state. The mobile app and the web bell both
  read this. This is the part that makes notifications a domain object rather
  than a fire-and-forget side effect.
- `notificationDestination` — one row per configured channel, with the per-event
  booleans and an `enabled` flag.
- `webhookDestination` / `telegramDestination` / `webPushSubscription` — the
  per-provider fields.
- `notificationDelivery` — the attempt log described above.

### Secrets

The Telegram bot token and the Web Push VAPID **private** key are secrets and go
through the existing sealed store (`seal`/`open`, as `sshKey.privateKeyEncrypted`
does), never in plaintext columns. A webhook URL can carry a token in its path, so
treat the whole URL as a secret too.

### Web Push

VAPID is the only push transport a lone self-hosted server can drive; APNs and
FCM need vendor credentials the operator will not have. One VAPID keypair per
deployment, generated on first use and sealed. `webPushSubscription` stores the
browser's endpoint and keys per user per device. A `410 Gone` from the push
service means the subscription is dead and must be deleted, not retried — this is
the one case where a delivery failure must **not** be retried.

### Webhooks and egress

A webhook URL is operator-supplied, so this is deliberate outbound egress from
the control plane. It needs a connect and total timeout, a response size cap
(the control plane already caps live-control responses at 1 MiB for the same
reason), a redirect limit, and `https` only unless the operator opts out.

## Events worth raising

| Event | Why it matters |
| --- | --- |
| `instance.exited` | A non-zero exit the supervisor will not retry. The bot is off and staying off. |
| `instance.never_joined` | The unit is running and live control answers, but the client never reached the server. The failure that looks healthy. |
| `host.unreachable` | SSH or reconcile failed, so a whole host's fleet is unmanaged. Fires on transition, not per poll. |
| `instance.drift` | The host stopped matching the expected config. |
| `instance.needs_auth` | A Microsoft sign-in expired and the instance cannot start. |

## Open questions for review

1. Is per-event booleans on the destination row right, or is a subscription table
   better once there are more than a handful of events?
2. Should `notification` rows expire? An operator with a noisy fleet accumulates
   rows forever otherwise.
3. Dedupe: a flapping instance could raise `instance.exited` repeatedly. Is a
   cooldown per (instance, kind) needed before the first version ships?
