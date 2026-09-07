# The email sender

Email is the last destination kind that cannot be created. The queue already carries it, the
worker already consumes it, and the retry loop already owns it — `dispatchTo` is the only thing
that refuses. This closes that.

## What is already in place, and it is more than it looks

- **The email queue is already consumed.** `apps/worker/src/bootstrap.ts` runs
  `boss.work(NOTIFICATION_EMAIL_QUEUE, workDeliveries(NOTIFICATION_EMAIL_QUEUE))` with the same
  handler as the HTTP queue. An email delivery already flows end to end and settles as a
  refusal. No queue, worker or producer work is in this slice.
- **The address validation transfers untouched.** `resolvePinned` takes a hostname and a policy
  and returns approved addresses. There is no HTTP anywhere in it — no undici, no URL parsing.
  It is reused as-is.
- The application-owned retry loop, `DeliveryOutcome`, the sealed config, the audit trail and
  the alerts UI all already work for a ninth kind.

## What has to be built, and it is exactly one thing

The **binding**. For HTTP, an approved address gets pinned by overriding an undici `Agent`'s
`connect.lookup`. SMTP has no such seam, so the socket is ours to open:

1. `resolvePinned(hostname, policy)` → approved addresses.
2. `net.createConnection` to the **pinned address**, never to a hostname. Nothing in this slice
   may perform its own DNS lookup; a library that resolves internally reopens the DNS-rebinding
   hole `sendPinned` exists to close, which is why no SMTP library gets to own the connection.
3. TLS with `servername` and `checkServerIdentity` set to the **operator-configured hostname**,
   while the socket underneath is connected to the pinned address. This split is the whole
   point: verify against the address and every certificate fails, skip verification and the
   pinning buys nothing. `rejectUnauthorized` stays on. There is no custom-CA option and no
   insecure-TLS escape hatch, because there is not one anywhere else in this codebase.
4. A minimal SMTP conversation, hand-written: `EHLO`, `STARTTLS`, `EHLO`, `AUTH`, `MAIL FROM`,
   `RCPT TO`, `DATA`, `QUIT`. Nothing else.

### Why hand-written rather than a library

Not dogma — three specific costs. A new runtime dependency has to survive
`scripts/check-runtime-deps.mjs` and `prune-deploy.mjs`'s `runtimeRoots` in **two** Docker
images, and getting that wrong has already crash-looped both containers in this project while
every unit test stayed green. It would also have to be read at the source level, not the README,
to confirm two things: that it accepts a pre-connected socket rather than resolving its own, and
that its STARTTLS transition discards the pre-TLS read buffer. If either cannot be confirmed
from source, the library is disqualified anyway. A client that does eight verbs and refuses
everything else is smaller than that audit, and `sendPinned` sets the precedent — it is
hand-built on undici rather than wrapping a full HTTP client.

### The STARTTLS trap, stated precisely because it is the one that bites

A MITM can pipeline plaintext commands immediately after the server's `220` reply to `STARTTLS`.
If the client keeps those buffered bytes across the TLS boundary, they execute afterwards as
though they arrived inside the encrypted session. So:

**After parsing the complete reply to `STARTTLS`, the read buffer must be empty. Any residual
byte means someone injected, and the attempt is abandoned — not retried, not downgraded.** That
is an assertion in code, and it is directly testable with a fake server that answers
`220 go ahead\r\n250 injected\r\n` in a single write.

Two details decide whether that assertion actually works:

- It is **synchronous on bytes already in hand**, never "wait a moment and see if more arrives".
  The injection test's whole premise is that both lines land in one `data` event, so the question
  is "having consumed the reply I recognise as complete, is anything left?" — evaluated against
  the buffer, not the clock.
- It uses the **same multi-line-aware reply parser as the rest of the client**. A reader that
  grabs one line only for `STARTTLS` would misfire on a legitimate `220-` continuation from an
  unusual but valid server, and a false positive here is exactly the kind of thing that later
  gets "fixed" by loosening the one check that matters.

`STARTTLS` is **required, never opportunistic**. If the server does not advertise it, or the
upgrade fails, the attempt fails. There is no plaintext `AUTH` or `MAIL FROM` path in this
slice at all.

## Three decisions, made rather than left to fall out of an implementation

**Port 465 means implicit TLS; every other port means `STARTTLS` is mandatory.** No port
allowlist and no new environment variable. Port 25 is not refused, because refusing it buys
nothing: the protection is the mandatory TLS, and a STARTTLS-stripping attacker on port 25
produces a *refused delivery* rather than a silent downgrade. Blocking 25 would only break the
internal smart-host relays that some self-hosted deployments legitimately run. `emailConfigInput`
gains no TLS field — the mode is derived from the port, so there is one fewer knob to set wrong.

One operational warning that has nothing to do with this plan and everything to do with an
afternoon lost to the wrong suspect: **most cloud providers and consumer VPS hosts block outbound
port 25 at the network level by default.** A connection that times out on port 25 is far more
likely the host's own firewall than anything in OpenMCC. That belongs in the field's hint text.

**Any rejected recipient aborts the whole send before `DATA`.** `DeliveryOutcome` has no
partial-success shape, and inventing one here would be the wrong place to do it. The reason this
is not merely a modelling convenience: silently dropping one recipient from an *alert* leaves an
operator believing their on-call was told when they were not.

With several recipients the rejections can be mixed — one address answers `250`, another `550` —
so the rule has to say which wins: **any `5xx` anywhere makes the whole attempt terminal, and
only an all-`4xx` set of rejections retries.** Retrying cannot fix a permanently bad address, and
`DATA` is never sent in either case.

**TLS always, with no plaintext exception, and this deliberately breaks symmetry with
`NOTIFICATION_ALLOW_HTTP`.** That escape hatch exists so a LAN gotify or ntfy server can be
reached, where the credential is a token in a header and the loss is confidentiality. SMTP `AUTH`
puts a reusable password on the wire, so a plaintext session is credential disclosure — a
different risk class, not a smaller version of the same one. If an operator with a TLS-less
internal relay needs this later it gets its own environment variable and its own argued
decision, rather than inheriting one silently from a setting about push notifications.

## Reading SMTP replies

`classifyHttpStatus` already has the right shape; SMTP's leading digit stands in for the HTTP
status class.

- **`4xx` → retryable.** 421, 450, 451, 452.
- **`5xx` → terminal.** 500, 550, 552, 553, 554.
- **`3xx` is protocol flow, not an outcome.** 334 and 354 are mid-conversation and never reach
  `DeliveryOutcome`.
- **Multi-line replies classify off the last line.** A reply is `250-continuation` lines followed
  by a final `250 ` line. Reading the first line and stopping is how a client desynchronises from
  the server for the rest of the session.
- **There is no `Retry-After` in SMTP.** No delay is parsed out of free text; `retryAfterSeconds`
  stays undefined and the shared backoff applies, exactly as it already does for a network
  failure.
- **No server text is stored or shown.** Reply text is diagnostic only, like every provider body
  before it. Persisted reasons stay static, non-technical copy.

## Secrets

- The SMTP password is sealed with the rest of the config and never appears in a view. The safe
  target is the from-address, which `targetFor` already returns for `email`.
- `redact.ts` gains the `AUTH PLAIN <base64>` shape, so a password cannot reach a log line even if
  a future change starts logging the conversation. Defence in depth: this slice logs no
  conversation at all.
- **`AUTH LOGIN` is deliberately not claimed as covered.** Its wire form is a challenge/response
  where the username and password each arrive as a bare base64 line with no prefix, so no static
  pattern can single them out from any other short base64-looking token without false-positiving
  constantly. The test must not imply otherwise. The real protection for `AUTH LOGIN` is that the
  conversation is never logged, and if it ever is, the redaction has to happen at the point of
  logging where the protocol state is known — not in a regex.
- Recipient addresses are not shown in the read model, matching the rule already proved for
  resend.

## Making it creatable

`CREATABLE_DESTINATION_KINDS` becomes all nine, `creatableDestinationConfigInput` gains its
email member, and `canBeCreated` stops excluding anything. The three
`Record<CreatableDestinationKind, …>` lookups in `apps/web` will **fail to compile** until email
is handled — that is the exhaustiveness guarantee from the last slice doing its job, and it is
the reason the form cannot be forgotten.

The form needs SMTP server, port, username, password, from-address and recipients. The port
field's hint says what the port implies about TLS, because that is the one place a user's choice
silently changes the security posture.

## What proves it works

- **A fake SMTP server in-process**, driving the client through a real socket. Not a mock of our
  own client — a server that speaks the wire format, so the test can lie the way a real server
  can.
- **The injection test**: the fake answers `STARTTLS` with `220 go ahead\r\n250 injected\r\n` in
  one write, and the attempt must be abandoned with nothing sent. This is the single most
  important test in the slice.
- **The downgrade test**: a server whose `EHLO` response omits `STARTTLS` gets no `AUTH` and no
  `MAIL FROM`, and the delivery fails.
- **The identity test, as a real handshake and not only an options assertion.** Both: assert the
  options handed to `tls.connect`, because that localises a regression fast, *and* stand up a
  local TLS server whose certificate has a SAN of `smtp.example.com`, bind it to `127.0.0.1`,
  connect the pinned socket to `127.0.0.1` with `servername: "smtp.example.com"`, and assert the
  handshake succeeds. The options assertion alone proves only that we *called* the API with the
  values we meant — not that Node's TLS layer verifies against `servername` rather than the
  socket's physical peer when a pre-connected socket is handed in, which is a much less travelled
  path than the ordinary `tls.connect(port, host)` one. A **negative control** comes with it: the
  same server with `servername` omitted must fail the handshake, so the test cannot pass by
  accident of a default happening to work.
- The certificate is a **checked-in test-only pair with a far-out expiry**, under
  `packages/core/src/notification/fixtures/`. Not generated per run: a fixture has no moving
  parts, and a certificate-generating devDependency would be one more thing to keep working for
  no gain. (It would not have reached the shipped images either way — `check-runtime-deps.mjs`
  and `prune-deploy.mjs` govern only what the Dockerfiles mark `--external:`.)
- **A multi-line reply test**, classifying off the last line, and a test that a `250-` first line
  followed by a `550` final line is read as terminal rather than delivered.
- **`RCPT TO` partial rejection**: `DATA` is never sent, `4xx` is retryable, `5xx` is terminal.
- **Port 465 skips `STARTTLS`** and goes straight to TLS; every other port requires it.
- **No credential in any stored string**: a safe-target test for email alongside the eight
  already there, and a `redact` test for both `AUTH` shapes.
- **Playwright** against a real SMTP receiver on the LAN, seeing a delivery settle — the same
  shape of proof the Gotify sender got, including that the sealed config holds the password and
  the view does not.
