# Logs and traces that can actually be followed

The goal an operator cares about: something goes wrong, and you can get from the alert to the
line that explains it without guessing. That needs three things this repository does not have —
structured logs, trace context, and a link between them.

## What is true today, read rather than assumed

- **There is no logger.** Not a thin one, not a wrapper — nothing. Every diagnostic is a bare
  `console.error`, twenty-one of them across the server and worker, plus one `console.warn`.
  So there is no timestamp, no level, no request identity, and no way to tell which of two
  concurrent deliveries a line belongs to.
- **No OpenTelemetry package is installed anywhere.**
- **`SendJob`'s payload is `Record<string, string>`**, so trace context can travel through the
  queue with no signature change. The shape already exists; nothing populates it.
- Biome's `noConsole` rule allows only `error` and `warn`. A logger that emits informational
  lines therefore cannot use `console.log` — it writes to `process.stdout` directly, which is
  what a log line should do anyway and keeps the rule intact rather than carving an exception
  into it.
- The OTLP endpoint is already in the deployment's `ConfigMap`
  (`http://alloy.monitoring.svc.cluster.local:4318`), so **this slice is application code with
  no manifest change**.

## The thing that must not happen

Slice A spent real effort keeping credentials out of stored failure reasons: the Discord and
Slack path tokens, the Teams `sig`, the ntfy topic, and every configured bearer. Then the ntfy
topic moved **into the URL path** for reverse-proxy compatibility.

**HTTP client auto-instrumentation captures the request URL as a span attribute by default, and
request bodies as a rule are not captured.** So switching on tracing naively would ship the
exact secrets to Grafana Cloud that this project just finished keeping out of its own database.
That is not a hypothetical: it is the default behaviour of the instrumentation everyone reaches
for first.

Therefore:

- **No HTTP client auto-instrumentation on the delivery path.** Deliveries already go through
  one function, `sendPinned`, so the span is ours to create by hand.
- **The outbound delivery span carries the safe target and nothing else** — the same
  `sanitisedTarget` the read model shows, which is an origin with the path elided. No
  `url.full`, no `url.path`, no query.
- **A test asserts it**, in the same shape as the safe-target tests: build a span for each of
  the nine kinds with a sentinel secret in every field, and prove no attribute contains it.

**A redaction hook was considered and rejected**, and the reason is not effort. OpenTelemetry's
built-in redaction covers URL userinfo and a query-key denylist; it has no notion of "this path
segment is the secret", which is precisely the ntfy case. `requestHook` can overwrite
`url.full` before the span ends, but it would have to re-encode the same per-kind knowledge
`sanitisedTarget` already holds — so it is not less code, it is the same logic plus a subtler
failure mode: **a hook that throws or is never registered fails silently**, shipping the raw
URL with no error and nothing structural to catch it. A hand-built span cannot contain the
secret in the first place. That difference — architecturally impossible versus configured
correctly — is the whole argument.

The generalisation worth writing down: **anything that leaves the process is a disclosure
surface, and a trace exporter is one.** Redaction earned in one channel does not transfer to
another for free.

## Structured logs

One small logger in `packages/core`, emitting one JSON object per line to stdout: timestamp,
level, message, and whatever fields the call site names. It replaces the twenty-two console
calls; nothing in the surviving surface takes a free-form string with values interpolated into
it, because a message with the values baked in cannot be searched on those values.

Alloy already collects container stdout, so JSON on stdout is the whole transport. No log
shipper, no file, no sidecar.

## Trace context, and the hop that makes it hard

The interesting request in this system does not finish in the request. An operator saves a
destination, the server enqueues, and a worker delivers seconds later in a different process.
A trace that stops at the HTTP response explains nothing about the delivery.

- The **server** starts a span per tRPC call and per HTTP request.
- **At enqueue**, the active context is serialised as W3C `traceparent` into the job payload —
  which is why the payload being `Record<string, string>` matters.
- **In the worker**, the payload's `traceparent` is extracted and the delivery span is created
  as its child, so the whole thing is one trace across two processes.
- **Database spans are hand-built too, and not for symmetry — auto-instrumentation cannot work
  in these images.** Every entrypoint is esbuild-bundled with `--format=esm` and run as a bare
  `CMD ["server.mjs"]`. OpenTelemetry's Node auto-instrumentation patches module loading, which
  for ESM has to happen through a `--import` / `--experimental-loader` flag on the process
  before the entry module evaluates. There is no such flag in either Dockerfile, and adding one
  would mean changing the container command — so the claim that this slice needs no deployment
  change would stop being true. Worse, the failure is quiet: `pg` spans would simply never
  appear while the hand-built spans still did, so the traces would look like they worked.

Parentage rather than span links, and that is the *documented* choice here rather than the
convenient one. The messaging conventions default to links because a span has one parent and a
batch consumer may pull messages from many producers — but they carve out an explicit opt-in
for single-message processing, which is exactly this case: one job, one destination, never
batched.

**The caution that comes with it:** if a generic job-dispatch span is ever added around the
handler — for queue-latency bookkeeping across all queues, say — it must not start its own root
span before the payload's `traceparent` is extracted, or there are two competing candidate
parents. Such a span **links** to the delivery trace; it does not out-parent it.

A detail that decides whether this is useful or merely present: **the retry of a delivery is a
new span in the same trace, not a new trace.** Eight attempts over an hour belong to the
alert that caused them, not to eight unrelated traces, and the `traceparent` stored on the
delivery row is what makes that possible.

### The seam a database span actually hangs off

`Executor` is a **type alias** (`Db | Tx`), so there is nothing there to wrap — twelve files
accept one, and a type cannot carry behaviour. The real single seam is one constructor:
`createDb` builds the only `Kysely` instance, handing a `pg` `Pool` to `PostgresDialect`. Every
query in the system goes through that pool's `query`. So the span is created by wrapping the
pool passed into the dialect — one place, no module patching, no loader flag, and it works
identically in the bundle and in tests.

**Not via Kysely's `log` option, even though it looks like the obvious hook** and hands over a
duration for free. It fires once, *after* the query completed, with no paired "before" — so
there is no moment at which the caller's active context can be captured. Building the span from
that single post-hoc event would parent it to whatever context happens to be ambient when the
log fires, which under concurrent queries is not reliably the one that issued that query. The
result would be spans with plausible-looking but wrong parents, and nothing would flag it —
worse than no span at all. So the wrap captures `context.active()` at query **start** and passes
it explicitly into `startSpan`.

The span carries the operation and the duration. **It does not carry the SQL text or the
parameters**, for the same reason the delivery span carries no URL: parameters are where the
sealed secrets and the host credentials live, and a trace exporter is an egress path.

### What gets installed, and what it costs

No `@opentelemetry/sdk-node` and no `@opentelemetry/instrumentation`. Those exist to register
module-patching instrumentation, which is the thing that cannot work here, and they drag in
`import-in-the-middle` and `require-in-the-middle` — which are themselves reported to break
when bundled rather than kept external. Instead, the low-level pieces only: `@opentelemetry/api`,
`@opentelemetry/sdk-trace-node`, `@opentelemetry/context-async-hooks`,
`@opentelemetry/exporter-trace-otlp-http`, and `@opentelemetry/resources` with
`semantic-conventions` for the attribute names.

None of those patch module loading and none carry native bindings, so **they are bundled by
esbuild rather than marked `--external`.** That is what makes the dependency-cost claim
actually true: nothing new is externalised, so there is **nothing to add to
`check-runtime-deps.mjs` or `prune-deploy.mjs`'s `runtimeRoots`** — the trap that has already
crash-looped both containers in this project simply does not apply.

### One deployment change is unavoidable, and an earlier draft of this plan denied it

This plan said "application code with no manifest change". The manifest part is still true. The
**Dockerfiles** are not.

Bundling the tracer exactly as the images do — esbuild, `--format=esm`, the same external list
— **builds cleanly and then dies on boot**:

```
Error: Dynamic require of "async_hooks" is not supported
```

`@opentelemetry/context-async-hooks` is CommonJS and calls `require("async_hooks")` with no
`node:` prefix. Under ESM output esbuild cannot emit a real `require`, so it substitutes a shim
that throws. The vitest suite stays green throughout, because vitest transforms source rather
than bundling — so this is the "green tests, broken container" failure this repository already
has a drift check for, arriving by a different door.

**Importing only the `AsyncLocalStorage` implementation does not avoid it, and this is
permanent rather than a bundling mistake to engineer around.** That was the obvious escape and
it was tested twice, independently: `AsyncLocalStorageContextManager.js` itself does
`require("async_hooks")` on line 9, unprefixed and independent of the package's barrel. Node's
`AsyncLocalStorage` class *lives in* the `async_hooks` core module, so no async-context
primitive can be used without requiring it somewhere. The package has no `exports` map, so the
deep import is *possible*; it simply changes nothing. **The banner is a required fixture of
using async context under esbuild plus ESM, not a workaround** — written down so nobody spends
an afternoon rediscovering it.

So all three esbuild invocations gain a banner that supplies a real `require`:

```
--banner:js=import{createRequire as __ocr}from'node:module';var require=__ocr(import.meta.url);
```

The alternative — marking the package `--external` — would trade one build flag for an entry
in `runtimeRoots` and the drift check, which is the more invasive of the two. The banner wins.

**Shutdown wants about ten seconds of grace, and that number is load-bearing.** A collector that
refuses the connection rejects immediately, but one that accepts and never answers exercises the
exporter's timeout instead — measured at roughly 10 seconds against a black-hole listener, which
is the OTLP exporter's default export timeout rather than a hang. That sits comfortably inside
Kubernetes' default 30-second `terminationGracePeriodSeconds`, **so anyone who tunes that down
to speed up rollouts has to leave tracing shutdown at least that much headroom** or the flush
this handler exists for will be killed mid-export. Losing the last batch on every routine
rolling deploy — not an edge case, every deploy — is worse than a bounded few-second delay.

**A telemetry failure must never take the service down.** The same probe also showed
`provider.shutdown()` rejecting with `ECONNREFUSED` when nothing is listening at the endpoint,
which as an unhandled rejection kills the process. So an Alloy outage, or one mistyped
endpoint, would stop the server and the worker — the observer killing the observed. `shutdown`
therefore cannot reject, and a test starts tracing against a closed port and asserts it
resolves.

## Correlation, which is the part that gets skipped

Every log line carries `trace_id` and `span_id` when a span is active. That single detail is
what turns two separate tools into one investigation: a log line in Grafana becomes a link to
its trace, and a slow span becomes a link to its lines. Without it there are logs and there are
traces and the operator does the join by hand, badly, at three in the morning.

Written as raw lowercase hex — thirty-two characters for the trace, sixteen for the span, no
`00-` prefix and no base64 — so it matches what the trace store holds with no transform.

**One thing this cannot deliver on its own, and the plan should not pretend otherwise.** Read
from the collector's own configuration rather than assumed:

- Alloy's log pipeline has **no JSON parsing stage at all**. Its `loki.process` block contains
  only three `stage.drop` filters — health, liveness and metrics paths — and forwards the line
  otherwise untouched to Grafana Cloud Loki. So nothing at collection time extracts a trace id,
  and there is no `trace_id` label on the stream.
- Its OTLP receiver listens on both 4317 (gRPC) and 4318 (HTTP), so the HTTP exporter this plan
  chooses is correct rather than merely available.
- The two apps already emitting set exactly one variable,
  `OTEL_EXPORTER_OTLP_ENDPOINT: "http://alloy.monitoring.svc.cluster.local:4318"` — identical
  to what the infra ConfigMap already carries.

**The exporter is handed an explicit URL rather than reading that variable itself**, for a
documented trap rather than testability alone: the SDK appends `/v1/traces` to
`OTEL_EXPORTER_OTLP_ENDPOINT` but uses `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` verbatim, and the
signal-specific variable takes precedence. Deferring would leave two independent readers of the
environment — the SDK's resolution and this code's own is-it-configured check — free to
disagree, producing a doubled or missing path that stays invisible until spans stop arriving.
One tested function owns the rule instead.

**A missing endpoint is announced once at boot**, with a `console.warn` in the same shape as the
existing `usesKnownInsecureKey` warning, so the absence of traces is itself in the log stream
rather than a silence someone has to notice.

The consequence is precise: because the line arrives at Loki unparsed, the log-to-trace link is
**entirely** a Grafana datasource concern — a derived field whose regex pulls the id out of the
raw line at query time. So a JSON line containing `"trace_id":"<32 hex>"` is exactly what a
derived field can match, and choosing that field name is the right call. But **shipping it
correctly and having the UI do nothing are the same outcome from the application's side**, so
wiring the datasource is a handover item, not something this slice can finish.

One incidental benefit of reading that config: the drop filter on `.*/health.*` means health
probe requests will not reach Loki, so per-request logging will not drown the stream in
readiness checks.

## What proves it works

- The logger's output parses as JSON, one object per line, with the level and message where the
  schema says.
- **A cross-process trace assertion**: enqueue with a known `traceparent`, run the worker
  handler, and prove the delivery span's trace id equals the one that went in. This is the
  claim the whole slice rests on, so it gets a test rather than a screenshot.
- **A retry keeps the trace**: two attempts of one delivery share a trace id and differ in span
  id.
- **The secret test above**, for all nine destination kinds.
- **The global context manager is actually registered.** Without an
  `AsyncHooksContextManager` installed at bootstrap, `getActiveSpan()` returns undefined
  forever — silently — and a logger test that threads a span in by hand still passes green. So
  one test calls the logger from inside a *real* active span, started through the global API and
  not passed in, and asserts the ids appear. This is the wiring with no coverage otherwise.
- ~~A retry with a real gap, not a same-second one.~~ **Cut deliberately, not forgotten.** The
  intent was an acceptance run forcing a multi-minute backoff to confirm a later span still
  resolves under the same trace id. What it would actually exercise is the *backend's* handling of
  a long-running trace, not this codebase: our side of the guarantee is that a retry re-enqueues
  the same `traceparent`, and three tests already prove that without waiting —
  `job-span.test.ts:74` keeps two attempts in one trace, `tracing.test.ts:181` does the same at the
  carrier level, and `delivery.job.test.ts:270,284` prove the handler re-spreads the carrier onto
  both the next attempt and the dead letter. Adding wall-clock realism on top buys a Grafana
  rendering question, which belongs with the derived-field wiring already listed as a handover
  item. If a long-gap trace ever renders incoherently, that is a tenant configuration bug and the
  place to check is the backend, not `delivery.job.ts`.
- No bare `console.` call remains **in the server and worker runtime paths**, asserted by a
  check in the style of the existing type-policy check. The scope is deliberate: **CLI
  entrypoints are excluded**, because `generate-sealbox-key-cli` printing the key it just
  generated is not a diagnostic — it is the answer the command was run to produce, and turning
  it into a JSON log line would make the tool worse. Test files are excluded for the same
  reason.
- The stack brought up, an alert fired, and the trace followed from the tRPC call through the
  queue to the delivery. Screenshots prove nothing on their own, but a trace that does not
  connect is immediately obvious.

## Deliberately not in this slice

- **Metrics.** Logs and traces answer "what happened to this alert"; metrics answer "how is the
  fleet doing", which is a different question and a different design. Doing both at once would
  do neither well.
- **Sampling.** At this scale every trace can be kept, and a sampling policy chosen before
  there is traffic to sample is a guess.
- **The `markDestinationOutcome` race**, which is queued separately and is a correctness bug
  rather than an observability one.
