# The remaining HTTP senders

Six destination kinds have config schemas, a database that accepts them, a queue that routes
them and a worker that consumes it — and cannot be created, because `dispatchTo` would refuse
them at delivery time. This closes that: discord, slack, teams, gotify, ntfy, resend.

Email stays out. SMTP is not HTTP, so the pinned-egress guarantee — resolve every answer,
validate all of them, pin the approved address into the connection — does not transfer, and
would have to be rebuilt for a different protocol. Bundling it here would hide the one hard
piece behind five easy ones.

## What is already in place

Nothing below needs new transport, signing, queueing or retry machinery:

- `sendPinned` with its DNS pinning, single end-to-end deadline and 64 KiB response cap.
- The application-owned retry loop, honouring a provider's requested delay.
- `classifyHttpStatus`, which already reads 2xx as delivered, 410 as stop-sending,
  408/425/429/5xx as retryable with `Retry-After` in seconds or as an HTTP date, and every
  other 4xx as terminal.
- Config schemas for all six, and `queueFor` routing.

So each sender is a **body shape, a bound on that body, and an outcome reading**. Four of the
six need no outcome reading at all: `classifyHttpStatus` is already exactly right for slack,
teams, gotify and ntfy. Only discord and resend report something the status line does not say.

## Teams: what is actually true

**Office 365 connectors in Teams were progressively disabled 18–22 May 2026.** Any
`webhook.office.com/webhookb2` URL has been inert since. Teams therefore means **Power
Automate Workflows**, and the URL question is the whole of the risk here.

Grounded facts:

- The modern generated callback URL is
  `https://<environment>.<NN>.environment.api.powerplatform.com/powerautomate/automations/direct/workflows/<id>/triggers/manual/paths/invoke?api-version=1&…&sig=<signature>`.
- The older `*.logic.azure.com` trigger endpoint stopped working on **30 November 2025**.
- When the trigger's access is set to **Anyone**, the generated URL carries a `sig` query
  parameter and is callable with no token. Every tenant-restricted mode requires an OAuth
  bearer token instead, and answers **401** to an unauthenticated call.

Therefore:

- **Supported hostname suffix, commercial cloud only:** `.environment.api.powerplatform.com`,
  matched on a label boundary against the lowercased hostname.
- **Sovereign and private clouds** are not shipped, because their suffixes are not grounded.
  `NOTIFICATION_TEAMS_HOSTS` takes a comma-separated list of additional hostname suffixes, the
  same escape hatch shape as `NOTIFICATION_ALLOWED_HOSTS`. Default empty.
- **Only the Anyone trigger mode is supported.** A URL with no `sig` parameter is refused at
  save time rather than stored to 401 on every delivery. Copy tells the operator to set the
  trigger's access to Anyone and paste the new URL. This is a deliberate coupling to a query
  parameter name; if Microsoft renames it the failure is a refused save with actionable copy,
  not a silent misdelivery.
- **`webhook.office.com` and `*.logic.azure.com` are refused by name**, with their own wire
  code, because "that address stopped working on a date" is a different remedy from "that is
  not a Teams address".
- **The whole URL is the credential.** `sig` authorises the call. It stays sealed, the safe
  target elides path and query, and redaction covers both the host suffix and any `sig=` value
  anywhere.

## Host restrictions at save time

A Discord webhook exists only on Discord; a Slack incoming webhook only on
`hooks.slack.com`. Constraining the host is what makes redaction complete and makes a typo a
refused save instead of an alert posted to a stranger.

| kind | hostname must be | why |
| --- | --- | --- |
| discord | `discord.com`, `discordapp.com`, or a subdomain of either | webhook URLs exist nowhere else |
| slack | `hooks.slack.com` | incoming webhooks exist nowhere else |
| teams | suffix `.environment.api.powerplatform.com`, plus `NOTIFICATION_TEAMS_HOSTS` | above |
| gotify | unrestricted | self-hosted |
| ntfy | unrestricted | self-hosted |
| resend | not configurable | fixed `https://api.resend.com/emails` |

Every configurable URL — not only the generic webhook — goes through `verifyDestinationUrl`
at create and edit, and through `sendPinned`'s own resolve-validate-pin on every attempt.
`checkUrl` currently returns early for anything but `webhook`; that is the bug this closes.

Gotify's and ntfy's `serverUrl` are **base** URLs we append to, so a query string or a
fragment on them is a mistake we refuse rather than silently drop. Userinfo is already refused
for every kind.

One nuance worth writing down: for a plain-HTTP hostname the pre-DNS check requires both
`NOTIFICATION_ALLOW_HTTP` **and** an exact entry in `NOTIFICATION_ALLOWED_HOSTS`. A
CIDR-only entry in `NOTIFICATION_ALLOWED_ADDRESSES` cannot authorise `http://name/`, because
HTTP is refused before resolution (`egress.ts:294`). Self-hosted gotify and ntfy are the
likely users of that path, so the `.env.example` comment says so.

## Each sender

- **discord** — `POST` the webhook URL with `{ content }`. No embeds: content-only keeps the
  body inside one documented bound (2,000 characters) instead of two (2,000 plus 6,000
  aggregate embed text). Success is any 2xx — the default execution answers **204**, and a
  `wait=true` request legitimately answers 200, so the shared 2xx reading stays. A 429 carries
  `retry_after` as a **float of seconds in the JSON body**, alongside the header. 400 is a
  malformed payload and is terminal.
- **slack** — `POST` the webhook URL with `{ text }`, truncated to 4,000 characters. Success
  is 200. `classifyHttpStatus` is already correct for the rest: 429 honours the integer
  `Retry-After` header, `500 rollup_error` is transient and retries, and the documented
  400/403/404/410 conditions are persistent and terminal. The plain-text body
  (`invalid_payload`, `channel_not_found`) is **never read and never surfaced**.
- **teams** — `POST` the Workflows URL with a non-interactive MessageCard
  (`@type: "MessageCard"`, `summary`, `themeColor`, `title`, `text`; no `potentialAction`,
  which Workflows does not support). Read the status line; Power Automate answers 202.
  Bounded to 25,000 bytes against the documented ~28 KB message limit.
- **gotify** — `POST {serverUrl}/message` with `X-Gotify-Key: <appToken>` and
  `{ title, message, priority }`. Priority is an **integer**; a string is rejected. Status
  line only.
- **ntfy** — `POST {serverUrl}` with `{ topic, title, message, priority }`, and
  `Authorization: Bearer <token>` when one is configured. Message is bounded to 4,096
  **bytes** on a UTF-8 boundary — past that ntfy treats the message as an attachment. Topic is
  already `[-_A-Za-z0-9]{1,64}` in contracts. Status line only.
- **resend** — `POST https://api.resend.com/emails` with `Authorization: Bearer <apiKey>`,
  `Idempotency-Key: <deliveryId>`, and `{ from, to, subject, text }`. It routes to the **http**
  queue, not the email one, because `usesEmailTransport` is about the transport and not the
  medium.

### Discord's body delay

A boundary parser, `parseDiscordRetryAfter` in `packages/contracts/src/boundary/discord.ts`,
because it decodes untrusted JSON and that directory is the only place `unknown` is allowed.
It accepts `retry_after` only when it is a **finite, non-negative** JSON number and
`Math.ceil`s it. The clamp to `MAX_RETRY_AFTER_SECONDS` belongs to core, where that constant
lives, so the parser stays a parser. `classifyDiscordReply` takes the **maximum** of the valid
body delay and the valid header delay, so neither source can make us retry earlier than the
other asked, and clamps that maximum; if neither parses, the delay is undefined and the shared
backoff applies. `parseRetryAfter` is left alone — it reads integers and HTTP dates, and
Telegram's boundary requires a non-negative integer.

### Resend's idempotency and its two kinds of 429

`Idempotency-Key` is the **delivery id**. A delivery row is exactly one notification for
exactly one destination, so the id is unique per destination and stable across every automatic
retry and every operator-triggered retry of that delivery. Resend keeps a key for 24 hours,
and the automatic loop exhausts its eight attempts inside about an hour, so every automatic
retry is always inside the window. An operator retrying a dead-lettered delivery more than a
day later falls outside it — an edge case this plan inherits rather than introduces, worth
knowing about and not worth a second mechanism. The request body is deterministic
for a given envelope, which is what makes the key safe to reuse. If a send succeeded but we
recorded a timeout, replaying the same key suppresses the duplicate email instead of sending
it twice — which is the reason Resend documents the header.

`NotificationEnvelope` gains `deliveryId`. `delivery.job.ts` already has `delivery.id` where
it builds the envelope.

A second boundary parser, `parseResendErrorName`, reads the body's `name`. Resend answers 429
for three different situations and only one of them is worth retrying:

- `rate_limit_exceeded` → retryable.
- `daily_quota_exceeded`, `monthly_quota_exceeded` → **terminal**. Retrying eight times inside
  the hour cannot clear a daily quota.

Everything else falls through to `classifyHttpStatus`, which already gets 403
`email_above_quota`, 422 validation failures and 503 right.

## Bounds

`bounds.ts` holds two functions and nothing else: `truncateChars(text, max)` and
`truncateBytes(text, max)`, the latter cutting on a UTF-8 code point boundary so it never
emits a broken sequence. Each sender bounds its own fields for the exact field and endpoint it
sends to, rather than relying on a global envelope maximum, so a future longer alert body
cannot quietly break one provider.

| kind | field | bound | what the bound is |
| --- | --- | --- | --- |
| discord | `content` | 2,000 chars | documented hard limit for the field |
| slack | `text` | 4,000 chars | Slack's own readability guidance; see below |
| teams | whole body | 25,000 bytes | under the documented ~28 KB message limit |
| ntfy | `message` | 4,096 bytes | past this ntfy treats the message as an attachment |

**Slack's number is the one that is not a platform limit, and the plan says so rather than
dressing it up as one.** Slack's documented hard behaviour on the top-level `text` field of an
incoming webhook is server-side truncation somewhere around 40,000 characters; its own
guidance recommends staying near 4,000 for readability. 3,000 would have been a mixed-up
citation — that is the limit on a Block Kit *text object*, which is a payload shape this slice
deliberately does not send. So 4,000 is an operational choice made to match Slack's guidance,
with 40,000 as the fact it can never exceed.

## Secrets

- **A provider-issued URL is itself a credential.** Discord's and Slack's secret paths and the
  Teams `sig` are the whole of the authorisation. Sealed at rest, elided in every view, and
  stripped from any message by `withoutTarget` before it is stored.
- **Configured tokens are headers, never query parameters.** `X-Gotify-Key` for gotify, bearer
  for ntfy and resend. No provider forces a token into a URL.
- `redact.ts` gains: `X-Gotify-Key: <value>`, the `.environment.api.powerplatform.com` host
  path, `*.logic.azure.com` workflow paths, and any `sig=` value in a query string. The
  `webhook.office.com` pattern stays, because an operator may still have one stored and its
  path is still a credential.
- **No provider body text reaches the browser.** Persisted failure reasons stay static,
  non-technical copy; status codes and provider bodies are internal diagnostics only.

## New wire codes

Each new refusal gets a `RejectionCategory`, a stable `ErrorCode` and static browser copy —
no server sentence is ever echoed. The web knows which kind is selected, so one code can read
naturally for each provider.

| category | code | remedy the copy gives |
| --- | --- | --- |
| `host` | `DESTINATION_WRONG_HOST` | this is not that provider's address; where to copy the real one |
| `retired` | `DESTINATION_ADDRESS_RETIRED` | that kind of address stopped working; create a Workflow and paste its URL |
| `signin` | `DESTINATION_REQUIRES_SIGN_IN` | set the trigger's access to Anyone and paste the new URL |
| `parameters` | `DESTINATION_HAS_PARAMETERS` | give the server address only, with nothing after the host and port |

## Making them creatable

`CREATABLE_DESTINATION_KINDS` grows to all nine but for `email`, and
`creatableDestinationConfigInput` grows to the matching eight members. The restriction stays
enforced in the creation and edit contracts **and** the controller, so email cannot be stored
until its sender lands.

`targetFor` currently falls back to the bare kind name for six of nine kinds. Each gets a real
safe target: an origin with an elided path for discord, slack and teams; the server origin for
gotify and ntfy; the from-address for resend. Never a token, never a secret path, never a
query string, never a recipient address.

The form needs the fields for each kind. The kind chooser already exists and already hides
itself on edit, because a destination's kind cannot change.

## What proves it works

- A colocated test per sender asserting the exact body it sends, that a success is read as
  delivered, and that a failure is read the way that provider actually reports it — discord's
  204 and its fractional `retry_after` rounding up, slack's 429 header, resend's
  `rate_limit_exceeded` retrying and `daily_quota_exceeded` not.
- A test that discord's boundary parser rejects `Infinity`, negatives, strings and objects, and that `classifyDiscordReply` takes the larger of body and header.
- A test that no sender puts a credential in a URL query parameter.
- A safe-target test **per kind** proving that the Teams `sig`, the discord and slack path
  tokens, the ntfy topic and token, the gotify token, the resend API key and every recipient
  address are absent from the view.
- A test that `redact` masks `X-Gotify-Key`, the two live Teams host shapes, the retired one,
  and a bare `sig=` value.
- A test that a `webhook.office.com` URL, a `logic.azure.com` URL, a Workflows URL with no
  `sig`, a non-Discord host on the discord kind and a `serverUrl` carrying a query string are
  each refused at save time with their own code, rather than stored.
- Controller tests covering create and edit validation and the audit record for every member
  of the widened discriminated union. Organization-scoped repositories keep the tenancy
  boundary; no new repository and no database enum.
- Each provider's bound proved by a truncation test, including `truncateBytes` on a multi-byte
  character at the cut.
- Playwright: create one of the six against a local receiver and see a real delivery settle.
