# Revamp plan

How open-mcc-manager grows from a supervisor that starts and stops clients into a
manager that controls them. Each stage ships something an operator can use.

The companion document is `mcc-integration.md`, which maps every MCC capability
onto a control-plane mechanism and cites the MCC source for each claim. This plan
argues from it and does not repeat it.

## Standing constraints

These bound every stage. They are not goals to trade off.

- **All control-plane-to-instance traffic goes over SSH.** No MCC port is ever
  reachable from any network. The tunnel is `direct-tcpip`, which creates no
  listening socket on either end.
- **A listening port still needs authentication.** The tunnel gives us a path to
  the port, not exclusive use of it.
- No Postgres enums. No `any`, no non-null assertions, no `@ts-ignore`. `unknown`
  only under `packages/contracts/src/boundary/`. `never` only in
  `packages/core/src/lib/exhaustive.ts`.
- No comments in application code.
- Spinners, never "…ing" text.
- `pnpm lint && pnpm typecheck && pnpm test` green before every commit.

## Where this stands

Stages 1 to 3 have landed and were verified against a real host rather than in tests alone:
config drift was proven by hand-editing a key over SSH and watching the UI name it; the
live channel was proven by calling every write tool through it and having the client refuse
each one; and a message typed into the console composer came back through the independent
read channel. Stage 4 has its gating keys, tab containers, and the world and entity reads.

What has not landed: chat **send** on modern servers (blocked upstream, below), the
inventory read, and Stage 5's push notifications, which still need a delivery channel chosen.

## What was already true when this was written

Worth stating, because two of these change what the later stages cost.

- **The tunnel primitive exists and is proven.** `canForward` already calls
  `conn.forwardOut("127.0.0.1", 0, "127.0.0.1", port)`
  (`packages/transport/src/connection.ts:113`), provisioning already probes it and
  warns when a host refuses forwarding (`packages/core/src/host/check.ts:113-121`),
  and a real forward against a real host returned HTTP 200 in 93 ms. What is
  missing is connection *lifetime*, not the primitive.
- **The console channel carries colour.** The instance unit runs MCC with
  `BasicIO` rather than `BasicIO-NoColor`, so section-sign codes survive into the
  journal, and `apps/web/src/lib/minecraft-text.ts` renders them.
- **The send path is live.** Chat, server commands and an allowlisted set of client
  commands all reach a running instance through the control FIFO.
- **Config drift does not exist yet.** `expectedUnits` compares unit files only.
  `MinecraftClient.ini` is written once at create and never read back.

## Stage 1 — Own the config file by key — **landed**

**Ships:** drift detection for `MinecraftClient.ini`, and an instance config editor
that cannot be silently defeated.

Byte comparison cannot work here and the reason is structural, not incidental: MCC
rewrites the file from its in-memory object graph on every successful load, on every clean exit, after sign-in and on update, and injects localised
comment prose that follows `Main.Advanced.Language`. A hash
comparison would report drift permanently, from the first start of every instance.

So compare **parsed keys we own**, and ignore the rest. Four classes, held as data
in `packages/core/src/instance/config.ts`:

| Class | Meaning | Drift means |
| --- | --- | --- |
| `MANAGED` | We render and compare it | Correct it |
| `FIXED` | We render it; not an operator choice | A safety property was defeated — say so differently |
| `RUNTIME` | MCC writes it, we never compare | Nothing |
| `UNMANAGED` | MCC's several hundred other keys | Nothing |

**`UNMANAGED` does not mean preserved, and the difference is destructive.** Measured on a
live host: MCC had expanded our instance config to 620 canonical lines, and a single save
from the settings UI replaced it with the 25 lines we render. Every key we do not write is
gone, and MCC restores its *default* for it on next load — not the operator's previous
value. So a hand-edited `TerrainAndMovements = true` is silently reverted by an unrelated
change to the anti-AFK interval.

Two ways to resolve it, and the plan takes the first:

1. **The manager owns the file.** Say so plainly in the UI and in `SECURITY.md`: manual
   edits to `MinecraftClient.ini` are not preserved. This is coherent for a manager whose
   whole purpose is removing configuration drift, and it costs nothing to implement.
2. Read-modify-write — parse the host's file, set only our keys, serialise the rest back.
   This needs a full TOML reader *and* writer, and it must survive MCC's own rewrite, which
   reorders and re-comments the file anyway.

Choosing (1) raises the stakes on what `MANAGED` covers: anything an operator might
reasonably want to set must become a managed key with a field, because everything else
resets. That is a direct argument for Stage 4's gating keys landing in Stage 1's model
rather than being discovered later.

Render only `MANAGED` and `FIXED`. Do not try to emit an MCC-canonical document:
that means reimplementing Tomlet's serialisation, MCC's comment injection and every
`OnSettingUpdate` normalisation, and keeping it correct across MCC versions — for
no benefit, because MCC overwrites the file regardless.

Comparison is semantic, not textual, and the file MCC actually writes proves why. Read back
from a live host, MCC had reshaped the `[Main.General.Account]` sub-table we wrote into an
**inline table**, `Account = { Login = "OpenMccBot", Password = "-" }`, and done the same to
`Server`. A comparison that does not normalise sub-table and inline-table spellings to one
dotted path reports permanent drift on every instance's account. Likewise
`Delay = { min = 10.0, max = 10.0 }` and `Delay = 10` mean the same thing to MCC.

Everything else we manage round-tripped unchanged, including the `{ min, max }` delay form,
which is already byte-identical to MCC's canonical output.

Whatever parses this file must also handle quoted keys containing spaces
(`Head."Current Version"`) and arrays with trailing commas
(`BotOwners = [ "player1", "player2", ]`).

**New `FIXED` key this stage must add:** `Main.Advanced.InternalCmdChar`. It
defaults to `slash` and governs how a line arriving on stdin is parsed. If an operator changes it, every line the manager writes
to the FIFO changes meaning — chat becomes commands, or commands become chat. The
send path is only sound while we own this key. *(Landed.)*

**And a second, which the first draft of this plan missed while explicitly asking whether
there was one:** `Main.General.Method`, the `{ mcc, browser }` switch. The client
branches on it and gates the device-code flow on `mcc`. Drifted to `browser`, MCC tries to open a system browser for OAuth on a headless
server, and the device-code scraping in `authenticate.ts` has nothing to read. In practice
MCC only writes this field through an interactive prompt reached when both `Login` and
`Password` are blank, which never happens for a manager-created
instance — so this is defence in depth against a hand edit, not a live drift path.
*(Landed.)*

## Stage 2 — One live connection per host — **landed**

**Ships:** nothing an operator sees. This is the transport every later stage rides
on, and it is separated so its failure modes are found before a feature depends on
them.

Use **`McpServer`, not `WebSocketBot`.** The capability map reverses an earlier
assumption here, on three grounds:

1. MCP reads its token from an environment variable. WebSocketBot's password has no such channel and
   would land in cleartext in a config file on the host.
2. WebSocketBot is loaded by `/script`, so after a client restart it does not come
   back until something re-issues the command. No reconnect logic fixes that.
3. MCP is config-driven, so Stage 1 already owns its settings.

**The bind address is rendered as a fixed literal and is never an operator
field.** It was `127.0.0.1`; since bots run in rootless Podman it is `0.0.0.0` inside
the bot's own network namespace, published on the host's loopback alone. MCC's own validation is worse than no validation: `Ipv4Regex` accepts `0.0.0.0` — a valid dotted quad — and accepts `+`
and `*` through explicit checks at line 205, all four of which expose the port,
while rejecting `localhost` and `::1`, the two spellings a careful person reaches
for. A wildcard bind does not throw, so the error handler at 232-242 never fires,
and line 244 logs `Starting on …` identically either way. Validate-and-warn is not
enough when the bad state is silent and immediate. The only safe design is to not
offer the choice.

**Connection shape:** one SSH connection per host, one `direct-tcpip` channel per
instance. A fleet of 200 instances across 10 hosts is 10 connections and 200
channels.

**The trap to design around:** `sshd`'s `MaxSessions` does not count port
forwardings, but it *does* count our `exec` channels, and it defaults to 10. A
pooled connection shared with reconciliation can exhaust `MaxSessions` while the
tunnels sit unaffected — and it presents as host failure, not as a limit.

Both mitigations are needed, not either: keep the tunnel connection separate from the exec
connection **and** bound exec concurrency well below `MaxSessions`. Separating them only
stops tunnels and execs competing; it does nothing to raise the per-connection exec ceiling,
and at 20 instances per host a future decision to reconcile a host's instances in parallel
would breach 10 on its own. Today every `exec` caller is strictly sequential, so there is no
live bug — only an uneforced invariant.

There is also no way to ask the server what `MaxSessions` is. The ceiling is discovered only
when a channel-open fails, and that failure is currently indistinguishable from any other
exec failure — which is precisely the "presents as host failure" problem above. Whatever
bounds concurrency must also name this failure when it happens.

**New keys this stage must add, and it is not optional.** Stage 1 owns the config file
outright and overwrites it with only what it renders. So every key the live channel needs
must be rendered here, or the channel deletes itself:

| Key | Class | MCC default |
| --- | --- | --- |
| `ChatBot.McpServer.Enabled` | `MANAGED` | `false` |
| `ChatBot.McpServer.Transport.RequireAuthToken` | `FIXED` | `false` — no initializer |
| `ChatBot.McpServer.Transport.BindHost` | `FIXED` | `"127.0.0.1"` |
| `ChatBot.McpServer.Transport.Port` | `MANAGED` | `33333` — see below |
| `ChatBot.McpServer.Transport.Route` | `FIXED` | `"/mcp"` |
| `ChatBot.McpServer.Transport.AuthTokenEnvVar` | `FIXED` | `"MCC_MCP_AUTH_TOKEN"` |
| `ChatBot.McpServer.Capabilities.SessionStatus` | `MANAGED` | `true` |
| `ChatBot.McpServer.Capabilities.ChatAndCommands` | `FIXED` | `true` — **we render `false`** |
| `ChatBot.McpServer.Capabilities.Movement` | `FIXED` | `true` — we render `false` |
| `ChatBot.McpServer.Capabilities.Inventory` | `MANAGED` | `true` — we render `false` |
| `ChatBot.McpServer.Capabilities.EntityWorld` | `MANAGED` | `true` — we render `false` |

**The port cannot be left at its default.** Every instance would take `33333`, and on a
rootless host they share one network namespace — so the second instance to start cannot
bind and its endpoint never appears at all. The port is allocated per instance.

### MCP is a read channel; the FIFO stays the only write

`mcc_run_internal_command` is MCC's *entire* internal command
surface behind a single tool call — `script`, `upgrade`, `connect` and the rest. Enabling it
would route straight around the FIFO allowlist and reinstate the arbitrary-code path that
allowlist exists to close.

It is gated by `ChatAndCommands`. The reads this project actually needs — `GetChatHistory`
and `GetRecentEvents`, plus player, server and world state — are gated by `SessionStatus`
instead. The two are independent, so the whole read surface is available with **no** write
surface, and `ChatAndCommands = false` is rendered as a fixed key.

Nothing is given up. Chat send, respawn and quit already travel over the FIFO behind an
allowlist that has been adversarially reviewed. Keeping one audited write gate is worth
more than a second path to the same actions.

Two toggles remain genuinely mixed: `Inventory` and `EntityWorld` each gate reads Stage 4
wants alongside mutations it does not (`DropInventoryItem`, `AttackEntity`). They are
therefore managed, default off, and Stage 4 must state the mutation each one also grants.

Miss them and the failure is not a security gap but a **total outage of the transport every
later stage rides on**, triggered by routine unrelated work: an operator adjusts an
auto-relog retry count, the save rewrites the file without the McpServer block, MCC restores
`Enabled = false` on next load, and live control is silently gone with no error anywhere.
This plan drew exactly that inference for Stage 4's gating keys and failed to apply it to
Stage 2, which comes first and has the identical exposure.

`RequireAuthToken` defaulting to `false` is the second reason it is `FIXED`: unset, the port
answers anyone who reaches it.

**Restart semantics:** the channel breaks, the SSH connection survives. MCP's port
exists only between `AfterGameJoined` and disconnect, so connection-refused means
"not joined yet", never "failure". It must not raise an alarm.

**Authentication is required even through the tunnel**, because the tunnel gives us
a path and not exclusivity: the port is published on the host's loopback, where any
process on the host itself can reach it. The token is per-instance and lives in the
sealed store.

### The isolation boundary, stated honestly

Each bot runs in its own rootless Podman container, with its own PID, mount and
network namespaces. A bot cannot see another bot's processes, read its environment or
files, or reach the host's loopback, where every bot's live-control port is published.
Its token reaches the client through `podman run --env-file`, from a file that is never
mounted into any container.

What bots share is one kernel uid: every bot runs as the enrolled account, so a container
escape yields that account and every bot on the host with it, tokens and session caches
included. `SECURITY.md` says this plainly rather than implying bots are isolated beyond
it.

## Stage 3 — Live chat and commands — **landed, minus chat send**

**Ships:** read public chat, system messages and whispers as they arrive; send server and
client commands from the browser. **Plain chat send is not in this stage's deliverable** —
it is blocked upstream on modern servers (below), and bundling it in would promise something
most operators cannot have.

**The read half is a poll loop, not a subscription.** MCP exposes `mcc_recent_events`
(cursor, count, type filter) and `mcc_chat_history` as request/response tools; there is no
push or subscribe primitive. Polling a cursor over an already-open tunnel is far lower
latency than snapshotting `journalctl`, and it is what "as they arrive" means here — nobody
implementing this should go looking for a streaming API that does not exist.

The send half already works through the FIFO. `Main.Advanced.MessageCooldown` (default
`1.0` seconds) sets the minimum interval between messages reaching the server; a burst sent
faster than that is **queued and delayed, not dropped** — `chatQueue` is an unbounded
`Queue<string>` that every send path enqueues onto, `TrySendMessageToServer` dequeues one per tick, and nothing ever clears it. The UI therefore
has to show latency, not loss: a message may sit for seconds before it is sent, and the
operator should be able to see that rather than assume it vanished. This stage replaces the polled
`journalctl` snapshot with a live event stream over the Stage 2 channel, and adds
the read half's structure: chat arrives as typed events rather than as journal text,
so whispers can be distinguished from public chat and system messages.

**Blocked upstream on modern servers, and it is not our bug.** Measured on two
sandbox servers with the same client, the same config and the same message:

| Server | Protocol | Path | Result |
| --- | --- | --- | --- |
| 1.19.2 | 760 | play-phase `SendClientSettings` | chat delivered |
| Paper 26.2 | 776 | configuration-phase `ClientInformation` | `Chat disabled in client options.` |

`MCSettings.ChatMode` defaults to `enabled` and the packet
writer looks correct, including the 1.21.2+ particle
status field, yet the server reads chat mode as not-enabled. Server commands and
client commands are unaffected. Narrow this to a single field and report it
upstream; do not ship a workaround that pretends the send succeeded.

**Rendering needs the JSON half of the text parser.** The legacy section-sign parser
exists. Modern chat components — `extra`, `translate` with `with`, `hoverEvent`,
`clickEvent` — do not. That input is untrusted JSON from the network, so under our
own rule it is parsed in `packages/contracts/src/boundary/` behind a zod schema,
never in `apps/web`. Translation keys resolve against a small injectable map, not
Mojang's full language file; an unrecognised key degrades to its arguments or its
raw key rather than throwing.

## Stage 4 — State the operator can see — **landed**

**Ships:** server GUI and inventory, live world and radar, health and position.

*All landed:* the three gating keys as managed settings, tab containers on the instance
page, the world read (server ticks, dimension, chunk load, position), the nearby-entity
list, and the player inventory.

The inventory read groups slots the way the client groups them itself — hotbar, main,
armour, offhand, crafting — taken from the client's own inventory view rather than
guessed from the protocol, and confirmed against a live client by giving it a helmet, a
sword, a stack of logs and a shield and watching which slots they landed in. MCC does not
name the individual armour slots, so neither does this.

These are reads over the Stage 2 channel, grouped because they share a shape — a
periodically refreshed projection of client state — and because none is worth a
connection of its own.

**They are not reads alone, and this is the correction the real config forced.** Three
keys gate them, and all three default to `false` in the file MCC writes:

| Key | Gates |
| --- | --- |
| `Main.Advanced.TerrainAndMovements` | movement, world view, radar |
| `Main.Advanced.InventoryHandling` | the inventory view |
| `Main.Advanced.EntityHandling` | entity data, radar contents |

So Stage 4 depends on Stage 1 owning these keys, and cannot ship by opening a channel.
MCC's own comment on `TerrainAndMovements` warns it "uses more ram, cpu, bandwidth" — which
runs directly against this project's reason for existing, a small-footprint supplement on a
server someone else is paying for. They are therefore **per-instance opt-in, never fleet
defaults**, and the UI must say what each one costs.

Tab containers land here, when there is enough on the instance page to warrant them.

## Stage 5 — Autonomy

**Ships:** push notifications.

*Not started.* The delivery channel is still undecided, and that decision is not this
plan's to make.

What the owner has ruled out, and why it narrows the design: **ntfy and Gotify are out.**
There is a mobile app planned for this control plane, built around self-hosted deployments
— the operator types the control plane's URL, the app asks that server which auth methods
it offers, authenticates, and drives everything from there. A second self-hosted daemon and
a second app to install fights that premise directly.

That makes the app the primary delivery target, which in turn means the control plane has
to own notifications as a real domain object — persisted, per-user read state, queryable —
rather than firing them at an external sink and forgetting them. Every outbound adapter
worth having sits on top of that feed, so the feed is the part that is not a guess. Note
also that self-hosting rules out anything needing a vendor account: Web Push (VAPID) is the
only real push transport a lone self-hosted server can drive, since APNs and FCM need
credentials the operator will not have.

Anti-AFK, auto-rejoin and respawn-after-dying are **already shipped** and were before this
plan was written: `ChatBot.AntiAFK.*` and `ChatBot.AutoRelog.*` are rendered, contracted and
exposed in the instance settings form, and `Main.Advanced.AutoRespawn` joined them as a
`MANAGED` key with its own toggle. `AutoRespawn` defaults to `false` upstream, which is why
a client that dies simply stays dead — observed live on a sandbox server twice, where a bot
was killed by a spider, then by a skeleton, and sat there until sent an explicit respawn.

What remains for this stage is therefore push notifications, plus folding those three
existing features into Stage 1's drift taxonomy once it exists. Neither touches the Stage 2
channel, so nothing here is genuinely gated behind Stages 2 to 4 — this stage is last by
value, not by dependency.

Push notifications need a delivery channel chosen before the stage starts.

MCC has its own `ScriptScheduler`, which duplicates the scheduler this repo already
has. Use ours: it is already audited, organization-scoped and visible in the UI,
and MCC's would be a second source of truth for the same behaviour.

## Deferred, with the reason

- **Mojang and Yggdrasil accounts.** Both need a password, and Yggdrasil an
  `AuthServerUrl`. That means a password field, sealed storage and a render path.
  Mojang's legacy login is dead upstream in any case. Offering them before that
  exists produces instances that cannot authenticate.
- **Custom proxies.** MCC supports them; nothing in the current feature set needs
  them, and each one is another egress path to reason about.
- **`ProfileKeyCache.ini` and `MinecraftClient.backup.ini`.** Both can hold secrets,
  and the manager does not currently know the backup file exists. Teardown must
  account for both.
