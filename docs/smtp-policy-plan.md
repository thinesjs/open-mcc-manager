# SMTP delivery policy

Two changes to how an email delivery succeeds, fails, and gives up. They share one file —
`packages/core/src/notification/smtp.client.ts` — so they are planned together and committed
separately, in the order below. A third change was planned and has been **dropped from this
slice**; the reasons are recorded at the end because they are worth keeping.

## Premise corrections, verified from source

- **The retry window is 31m45s, not ~64 minutes.** `DELIVERY_RETRY_LIMIT = 8` means eight
  attempts and *seven* delays: 15+30+60+120+240+480+960 = 1905s. The 1920s delay would precede a
  ninth attempt that never happens.
- **The certificate family has 12 explicit entries, not 13**, plus prefix and substring matching
  at `failure.ts:61-63`.
- **Multi-recipient behaviour is already tested.** `smtp.client.test.ts:266` covers permanent
  partial refusal, mixed refusal and all-transient refusal against a real socket. Those tests pin
  the *current* design, so the first one must be rewritten rather than added to.
- **A stable `Message-ID` does not prevent a duplicate.** It establishes identity; SMTP receivers
  are not required to deduplicate on it. `smtp.sender.test.ts:202` overclaimed this and has
  **already been renamed** in 5c2e271 to "carries the delivery id as stable message identity across
  retries"; no further action.

## Change 1 — try the next address only when nothing has been delivered

`smtp.sender.ts` walks the pinned addresses but only `continue`s on connect and TLS-upgrade
failure. Once `converse` starts, any failure returns and the remaining addresses go untried.

That is right where delivery is *ambiguous*, and wrong everywhere else. A greeting, `EHLO`,
`STARTTLS`, `MAIL FROM` or `RCPT TO` failure cannot have delivered anything, so refusing to try a
healthy second address buys no duplicate protection at all.

**The boundary, precisely.** The `DATA` command is not mail data. A failure after sending `DATA`
but before receiving `354` is safe to fail over, because no message content has been submitted.
The ambiguous region begins immediately before the payload write at `smtp.client.ts:194` — mark it
ambiguous *before* calling `step(...)`, since a rejected write cannot prove zero bytes reached the
server.

**A lost final reply is ambiguous; an explicit final reply is not.** After the terminating dot, a
`4xx` or `5xx` means the server has told us it will not deliver, so failing over is safe. Only
losing the reply is genuinely ambiguous. We take the precise rule rather than the blanket
"never fail over once the write was attempted", because the existing reply classification already
distinguishes the two cases.

**Pre-DATA replies.** A transient `4xx` is duplicate-safe and should reach the next address, since
the transaction is being abandoned without DATA. A `5xx` is *also* duplicate-safe, but stays
terminal as a matter of policy — because the reply declares a permanent refusal, not because
trying elsewhere would be unsafe. The earlier claim that "the next server would refuse
identically" was too strong: multihomed servers can disagree. And a different recipient set on the
next address is harmless when the first connection received no DATA.

**Shape.** `converse` returns an internal discriminated union carrying the outcome plus whether
another address may be tried — two cases, "try next address" and "settled", switched with
`assertExhaustive`. This cannot be folded into `DeliveryOutcome.kind`, and one counterexample
inside this slice settles it: a lost reply after the terminating dot is **retryable** — we will
try again on the schedule — and simultaneously **unsafe to fail over now**, because the message
may already have been accepted. So `retryable` does not imply "try the next address", and no
value of `kind` can carry that distinction. Failover safety and outcome kind are independent
axes, which is what justifies the extra type.

(An earlier draft justified this with a terminal certificate failure being safe to try elsewhere.
That example is withdrawn: certificate terminalization is deferred below, so no such outcome
exists in this slice, and a plan should not lean on work it is not doing.)

## Change 2 — deliver to the recipients that were accepted

Today `smtp.client.ts:181-189` collects every `RCPT TO` refusal and returns before `DATA` is ever
sent. A destination with three recipients where one address has a typo therefore alerts nobody.
Converting "two people were alerted" into "nobody was alerted" is the worse incident outcome, and
SMTP treats each `RCPT TO` independently.

**Policy.** Track accepted recipients alongside the refusal codes.

- No recipient accepted: keep exactly today's classification — retry if every refusal is
  transient, terminal otherwise.
- At least one accepted: send `DATA` to those recipients. On a positive final reply, return
  **terminal** with `stopSending: false` and the static reason "That mail server refused one or
  more of the addresses".
  This copy is **amended from the approved plan**, which said "The mail server refused one or more
  recipients." Every one of the eight sibling constants in `smtp.client.ts` opens with "That mail
  server" and calls them addresses, `REFUSED_RECIPIENT` being the exact singular parallel at "That
  mail server refused one of the addresses". The approved wording broke both conventions and added
  a trailing period no sibling carries, so an operator would have seen one message from a different
  family than the rest. The amendment is deliberate and flagged for review rather than drifted.
- `terminal`, not `delivered`, because `delivered` clears destination failure state at
  `delivery.job.ts:155` while `terminal` records it at `:170` and surfaces it on the dashboard at
  `_authenticated.alerts.tsx:286`. Calling a partial send "delivered" would silently hide a broken
  configured recipient. A fourth `partial` state is disproportionate.
- **`statusCode` carries the refusal that explains the failure** — a permanent refusal if there
  was one, otherwise the first transient refusal. Never the final positive `250`, which would be
  misleading in `notificationAttempt`.
- A final `4xx` or `5xx` after the dot overrides the partial result entirely: nothing was
  delivered, so it settles as an ordinary failure.
- Do **not** retry a partial delivery, even when a refusal was transient. That recipient misses
  this alert. The alternatives are worse: aborting lets one greylisted address block everyone,
  retrying duplicates mail to those already served, and retrying only the refused set needs
  persisted per-recipient state. A manual operator retry can still duplicate, but that is an
  explicit choice.
- **Preserve the configured `To` header.** Envelope recipients and message headers are
  deliberately separate, and a refused recipient is still an intended one. Rewriting the header
  would make the message bytes depend on one server's transient envelope decision, hide who the
  operator meant to notify, and let one stable `Message-ID` identify different content on a later
  retry. Accepted recipients decide only whether `DATA` may proceed; `messageBytes(message)` keeps
  receiving the original message.
- The reason must never name a recipient.

Once a partial send has received a positive final reply, do not try another address.

## What the tests must prove

Two categories, and the distinction matters because conflating them is how a suite looks
thorough while proving nothing:

- **Discriminating** tests fail if the implementation is reverted while these tests remain.
  They are the evidence.
- **Over-reach guards** pass both before and after the intended change, but fail if the
  implementation alters adjacent behaviour. They are not evidence that the change went far enough.

**Assert observable seams, not private mechanics.** Revert-failure is necessary evidence, not
permission to assert source structure, exact helper calls, or an internal union tag. The seams
worth asserting are: the socket transcript and the captured DATA payload; which pinned addresses
were opened; the returned `DeliveryOutcome`; whether another delivery job was queued; and the exact
operator-visible reason and recorded status code. Testing the internal conversation union is
reasonable as the contract between `smtp.client.ts` and `smtp.sender.ts`, but pair it with a
sender-level address-attempt test.

### Change 1 — discriminating

- A failure while waiting for `354` reaches the second address.
- A transient pre-DATA reply reaches the second address, **using distinct replies so the chosen
  outcome is observable** — first address `421`, second `450`. Assert both addresses were
  opened and that the returned outcome is retryable carrying the **last** reply's status.
  Without distinct codes this cannot show which failure was selected: `smtp.sender.ts:70`
  seeds `lastFailure` and overwrites it each iteration, so the outcome after exhausting every
  failover-eligible conversation failure is otherwise unspecified and untested.
- An `RCPT` disconnect after an earlier acceptance reaches the second address.
- An explicit final `4xx` after the terminating dot **reaches the second address** — that is the
  chosen policy, so assert it rather than describing it vaguely.
- A **STARTTLS upgrade failure inside `converse`** reaches the second address. This discriminates
  because HEAD returns directly on any conversation failure.

### Change 1 — over-reach guards

- A **payload-write rejection** must NOT reach the second address. The plan marks ambiguity before
  calling `step`, and only losing the reply after the terminator is otherwise covered; a rejected
  write is the other half of that boundary.
- Receiving a final `250` and then failing to write `QUIT` must **remain delivered** and must not
  try another address. HEAD deliberately preserves delivery there (`smtp.client.ts:197`).
- The permanent-reply guard is **phase-specific**: an explicit pre-DATA `5xx` and an explicit final
  `5xx` both settle without trying another address. This is what separates permanent-reply policy
  from ambiguity, and it replaces the earlier blanket "a terminal refusal does not reach the second
  address", which conflicted with the STARTTLS case above.
- A server that does not advertise required STARTTLS is terminal via `classifyRefusal`
  (`smtp.client.ts:145`, which returns `classifyRefusal` — `kind: "terminal"` with
  `stopSending: false` per `outcome.ts:72-77`) and settles without another address.

### Change 2 — discriminating

- Mixed accepted-plus-transient returns a **terminal** outcome where HEAD returns retryable. Prove
  this through the real SMTP result, not a `delivery.job` test fed a mocked terminal outcome — the
  latter proves nothing about this change, because existing delivery handling already settles
  terminal outcomes as failed (`delivery.job.ts:144`).
- The `To` header contains the original configured recipients, asserted as an **exact `To:` line**
  from the captured payload.
- The exact static reason.
- After a partial delivery receives its final `250`, the **second pinned address is not tried**.
- A final `4xx` and a final `5xx` after the dot are tested **separately** — they produce different
  outcome kinds — and each uses a code **distinct from the earlier RCPT refusal**, otherwise the
  status-code assertion could pass against HEAD without DATA ever being sent.

### Change 2 — over-reach guards

- All recipients accepted still settles `delivered`.
- Zero accepted with all-transient refusals stays retryable; zero accepted with a permanent refusal
  stays terminal.
- No reason contains an address, port or credential.
- The chosen `statusCode` is **not independently discriminating** — HEAD already returns the refusal
  code — so it belongs here rather than above. What still needs covering is both selection
  branches: one accepted plus multiple transient refusals yields the **first transient** code, and
  one accepted plus transient-then-permanent yields the **permanent** code.

### The complete scenario matrix for Change 2

1. Accepted + multiple transient refusals + final `250`.
2. Accepted + transient then permanent refusal + final `250`.
3. Partial envelope + distinct final `4xx`.
4. Partial envelope + distinct final `5xx`.
5. Partial success on the first of two pinned addresses, asserting no second attempt.

The fake server needs **two** changes before any of this is testable, not one. It currently
discards the payload — pushing the literal `"<message>"` — and hardcodes `250 queued` as the
final reply. So it must (1) capture the exact DATA payload, for the `To:` line assertion, and
(2) emit a **test-selected** final reply after `\r\n.\r\n`, without which the distinct final
`4xx`, final `5xx` and final `250` cases above cannot be written at all.

Rewrite the first test at `smtp.client.test.ts:266` because it pins the opposite policy; keep the
other two, renamed for what they now cover. Do not leave old and new versions side by side.

## Ordering

Change 1 first, then Change 2. Change 1 establishes the conversation-result contract and the
failover boundary; Change 2 then alters only recipient collection and partial settlement inside
that contract. The reverse order would restructure the same RCPT/DATA block twice. Separate
commits — independently reviewable policies with different rollback risk.

## Dropped from this slice: certificate failures as terminal

`classifyNetworkFailure` at `outcome.ts:65-70` hardcodes `kind: "retryable"` for every network
reason including the whole certificate family, so a destination with a self-signed certificate is
retried eight times across 31m45s every time it is alerted. Making the certificate family
terminal-but-not-disabling looked cheap. It is not, for three reasons found by review:

1. **The premise was false at HEAD.** Conversation failures do not call `classifyNetworkFailure` —
   the catch at `smtp.client.ts:203` builds a retryable outcome directly. So changing `outcome.ts`
   alone would terminalise implicit-TLS failures and miss STARTTLS-upgrade failures entirely.
2. **The classifier is shared with the eight HTTP kinds** via `sender.ts:65`, which calls
   `classifyNetworkFailure(networkReason(...))` for every thrown transport error. This is not an SMTP
   change at all; it is a cross-transport retry-policy change wearing an SMTP costume.
3. **The blanket `ERR_TLS*` match is the wrong boundary.** `ERR_TLS_HANDSHAKE_TIMEOUT` is a
   timeout, and terminalising it would convert a transient network event into a permanent
   per-alert failure.

So it is deferred as an explicit, global notification retry-policy decision rather than allowed to
ride along here. When it is taken up: classify only known certificate, trust and
protocol-configuration codes, guard `ERR_TLS_HANDSHAKE_TIMEOUT` as retryable, and test an HTTP
sender as well as SMTP.

## Also settled, no work

- **`stopSending` stays 410-only.** RFC 9110 makes 404 deliberately ambiguous about permanence and
  reserves 410 for likely-permanent conditions. 401, 403 and 404 all recover without the
  configured destination changing, and are already terminal per-alert so consume no retry budget.
  Auto-disabling silently abandons every future queued alert — the worse enterprise failure.
- **`redact.ts` gains no ntfy rule.** A host-agnostic "redact the last path segment" rule would
  destroy diagnostics, break the guarantee at `redact.test.ts:104-106`, and still miss a server
  mounted below a path; bare value redaction is unsafe because a topic can be one character. The
  sender path already routes thrown transport errors through `networkReason`, which discards the
  raw message, and a regression test now proves a full ntfy URL, host, port, topic and token reach
  no operator-visible reason.
- **The trailing CRLF in `wrappedBase64` stays.** It is valid and MIME decoders ignore line breaks.
  The invariant worth holding is "no mail-data line begins with a dot", which is now tested and is
  the only reason the absent dot-stuffing is safe.
- **`terminal + stopSending: false` settles correctly.** It fails and dead-letters at
  `delivery.job.ts:176` and disables only when `stopSending` is true at `:177`. The dead-letter
  queue is deliberately inert and retained 30 days — `queue-setup.ts:17` defines
  `DEADLETTER_RETENTION_SECONDS` and `:70-71` apply it as `retentionSeconds` and
  `deleteAfterSeconds`; `:64` only names the queue. It is an audit marker, not a recovery
  mechanism, and nothing processes it. The failed delivery row is what the dashboard exposes
  and what an operator requeues.
