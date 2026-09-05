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

## What is already true

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

## Stage 1 — Own the config file by key

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

## Stage 2 — One live connection per host

**Ships:** nothing an operator sees. This is the transport every later stage rides
on, and it is separated so its failure modes are found before a feature depends on
them.

Use **`McpServer`, not `WebSocketBot`.** The capability map reverses an earlier
assumption here, on three grounds:

1. MCP reads its token from an environment variable. WebSocketBot's password has no such channel and
   would land in cleartext in a `.cs` file on the host.
2. WebSocketBot is loaded by `/script`, so after a client restart it does not come
   back until something re-issues the command. No reconnect logic fixes that.
3. MCP is config-driven, so Stage 1 already owns its settings.

**The bind address is rendered as a literal `127.0.0.1` and is never an operator
field.** MCC's own validation is worse than no validation: `Ipv4Regex` accepts `0.0.0.0` — a valid dotted quad — and accepts `+`
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
tunnels sit unaffected — and it presents as host failure, not as a limit. Keep the
tunnel connection separate from the exec connection, or bound exec concurrency well
below `MaxSessions`.

**Restart semantics:** the channel breaks, the SSH connection survives. MCP's port
exists only between `AfterGameJoined` and disconnect, so connection-refused means
"not joined yet", never "failure". It must not raise an alarm.

**Authentication is required even through the tunnel**, because the tunnel gives us
a path and not exclusivity. On a rootless host every instance shares a UID and a
network namespace, so a sibling can reach the port. The token is per-instance and
lives in the sealed store.

### The isolation boundary, stated honestly

On a **rootless** host, sibling instances are separated by a *file* boundary only —
the mount namespace (`ProtectHome=tmpfs` plus `BindPaths`) hides one instance's
directory from another. They are **not** separated at the process level: a shared
UID means siblings can already signal each other, read each other's
`/proc/<pid>/environ`, and so reach any token held in an environment variable.
`ProtectProc=invisible` does not help, because it hides processes owned by *other*
users and rootless siblings share one.

A listening loopback port therefore does not widen the rootless threat model — an
attacker who controls one rootless instance already controls them all. Real
per-instance separation is what `system` mode provides, through per-instance OS
users (`usesPerInstanceUsers`). `SECURITY.md` must say this plainly rather than
implying instances are isolated from one another.

## Stage 3 — Live chat and commands

**Ships:** the feature as specified — read public chat, system messages and whispers
in real time; send chat and commands from the browser.

The send half already works through the FIFO. It must respect
`Main.Advanced.MessageCooldown` (default `1.0` seconds, the minimum interval between
messages to the server), or a burst is silently dropped. This stage replaces the polled
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

## Stage 4 — State the operator can see

**Ships:** server GUI and inventory, live world and radar, health and position.

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

**Ships:** anti-AFK, auto-rejoin, push notifications.

`Main.Advanced.AutoRespawn` defaults to `false`, which is why a client that dies simply
stays dead — observed live on a sandbox server, where a bot was killed by a spider and sat
there until sent an explicit respawn. It becomes a `MANAGED` key here.

MCC has its own `ScriptScheduler`, which duplicates the scheduler this repo already
has. Use ours: it is already audited, organization-scoped and visible in the UI,
and MCC's would be a second source of truth for the same behaviour.

Push notifications need a delivery channel decided before this stage starts; that
decision is not made here.

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
