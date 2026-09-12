# MCC compatibility ledger

`MCC_VERSION` in `packages/core/src/host/mcc-release.ts` names the build every
host installs. The per-architecture digests beside it already stop a host from
drifting onto a different build — wrong bytes fail provisioning. Nothing stops
the build itself from moving out from under the code that assumes how it
behaves, and that code is large: an audited key registry, a drift comparison, a
config renderer, a bot dependency table, a live-control wire format. None of
them fail loudly when the client changes. They keep validating, comparing and
rendering the old build's shapes.

So this file is the record that someone looked.
`packages/core/src/host/mcc-compat.test.ts` fails while the newest entry under
**Audits** does not name the deployed version: the bump and the audit land
together, or neither lands. The same test fails while
`packages/contracts/src/boundary/mcc-config-fixture.ini` records a different
build from the one hosts install. That check reads the fixture's recorded build
string and nothing more — it does not inspect the key surface, and a determined
person can edit the header without recapturing anything. It is a prompt, not a
proof: four test suites compare against that fixture, so a header that disagrees
with its own body is a visible lie for a reviewer to catch.

## Auditing a bump

Read the new tag's own source, not whatever a local checkout happens to hold —
a clone here once sat 15 months behind and did not contain the live-control
feature at all, so a round of "verified against the client" had been checked
against a version that never had it. Confirm the tag before trusting a tree:

    git -C <checkout> fetch --tags
    git -C <checkout> show <tag>:MinecraftClient/Settings.cs

Then provision one host on the new build and capture its expanded
`MinecraftClient.ini` over the fixture, dropping the client's own comments —
they are that project's prose and this repository is MIT-licensed while the
client is CDDL-1.0. Everything below is easier to answer with the new client's
own file in hand, and the parser, drift and bot-field tests compare against it,
so until it is re-captured they are all still testing the old build.

`git diff <old tag>..<new tag> -- MinecraftClient` is the whole surface. The
five headings below are where its consequences land, and each one fails
silently. A moved digest, a renamed asset or a client that will not start are
not on the list on purpose: provisioning verifies the checksum and probes
`--help` for the `Minecraft Console Client` banner, so those fail loudly, at
install time, before a host is left in a bad state.

**Key registry** — `packages/contracts/src/boundary/mcc-config-keys.ts`. For
every key in `ADVANCED_KEY_SHAPE` and `BOT_CONFIG_SHAPE`: it still exists at
the new tag, its C# type is unchanged, its enum members are unchanged, and the
range its bot's `OnSettingUpdate()` clamps to is unchanged. A retype or a
re-clamp is the one thing no test can catch. The registry would keep validating
the old form, `Program.cs` calls `WriteBackSettings(true)` right after loading,
and the clamped value is persisted to the host's file — so it drifts forever
and "Restart to fix" never fixes it. A key the new build drops leaves the
registry; a key it adds stays out until someone audits it, because
`advancedKeysSchema` and `botConfigSchema` are `.strict()` by design.

**Config drift** — `packages/core/src/instance/config-drift.ts`. `operator`
drift means a key we saved is no longer what the host holds, so anything the
new client rewrites on load reads as permanent drift the operator cannot clear.
Recheck the tables that encode client behaviour rather than our intent:
`EXPANDS_ON_THE_CLIENT` and `DEFAULT_CARRIES_A_TOKEN` (a default that carries
`%serverip%` is reported as `fixed`, which is why an absent key is not a safe
key), the expansion tokens the client fills in, and `EMPTIED_CONFIG_SECTIONS`.
A new section MCC writes on expansion is invisible here until it is listed.
`MinecraftClient.ini` is read as TOML by `smol-toml`; a dialect change makes
every key `unreadable` at once.

**Renderer** — `packages/core/src/instance/config.ts`. The rendered file is
written table by table, so a renamed table or key is accepted by the client and
silently ignored: `is-active` is not health, and the instance sits there with
the setting doing nothing. Check the pinned literals the client parses by name
(`ConsoleMode = "classic"`, `InternalCmdChar = "slash"`, `Method = "mcc"`,
`ExitOnFailure = true`), the quoting and list syntax in `QUOTED_CONFIG_NAMES`
and `LIST_CONFIG_NAMES`, and the `min`/`max` range form used for the relog and
AntiAFK delays.

**Bot capabilities** — `apps/web/src/lib/bot-config-fields.ts`. Seven of the
eight `ChatBot.*` bots do nothing without one of `TerrainAndMovements`,
`InventoryHandling` or `EntityHandling`, which the bots read directly
(`McClient.cs`). For each entry in `BOT_CONFIG_DEPENDENCIES`, confirm the thing
genuinely still stops working without what it requires, and that no bot gained
a dependency the table does not declare. A dependency is a hint, not a refusal,
so a wrong one costs an operator a confusing dead setting rather than a failed
write — which is exactly why nothing else catches it.

**Live control** — `packages/contracts/src/boundary/mcp.ts` and
`packages/core/src/instance/live-control.ts`. Check `MCP_PROTOCOL_VERSION`
against the handshake the new build accepts, MCC's `{success,data}` envelope,
the SSE framing, the tool names and result shapes, and that the transport still
takes its bearer token from an environment variable and still serves the route
the renderer pins. This is the surface that already burned this project once.

## Audits

Newest first. One entry per deployed version; the bullet labels are the six
surfaces above and the test requires a finding under every one. Start each
finding with `- Label:` at the left margin — wrapped prose and indented
sub-bullets belong to the finding above them, and a dash at the left margin
starts a new one.

### 20260829-511

Baseline, recorded 2026-09-13. This is the tag the project was built against,
so no predecessor was diffed. What each surface rests on, and what the next
bump must recheck:

- Key registry: every registered key was audited at this tag when it was
  registered — existence, C# scalar type, enum members, rendering table, and
  the bound its `OnSettingUpdate()` clamps to. `ChatBot.AutoAttack.Cooldown_Time`
  `.Min`/`.Max` are swapped by the client rather than clamped, so their order is
  checked across rows instead of as a per-key bound.
- Config drift: the fixture is this build's own expanded config, so the parser
  and the comparison are exercised against its real key surface.
  `EXPANDS_ON_THE_CLIENT` covers `ChatBot.ChatLog.Log_File` and
  `ChatBot.PlayerListLogger.File`; only the former's client-side default carries
  a token at this tag. `EMPTIED_CONFIG_SECTIONS` covers
  `Main.Advanced.AccountList` and `Main.Advanced.ServerList`, the two the client
  expands on first run.
- Renderer: the rendered file is compared against this tag's expansion of a
  fresh `MinecraftClient.ini`, including the `[ChatBot.McpServer]` block and the
  capability keys gated on `liveControlEnabled`.
- Bot capabilities: `BOT_CONFIG_DEPENDENCIES` was derived from this tag's bot
  sources, one bot at a time. `ChatBot.AutoEat` carries a declared dependency on
  inventory handling although the client never checks for it, and
  `ChatBot.AutoFishing.Detection_Warmup` carries none because it is read on
  every catch path.
- Live control: `MCP_PROTOCOL_VERSION` is `2025-06-18`, the route is `/mcp` on
  loopback, and the bearer token is read from `MCC_MCP_AUTH_TOKEN`. The
  `{success,data}` envelope and the tool readouts in `mcp-readouts.ts` were
  taken from `MinecraftClient/Mcp/` at this tag.
- Journal and exit signals: every literal read out of the client's own output
  was observed at this tag, not guessed — `STUCK_MARKERS`, `SERVER_INFO_MARKER`,
  `JOINED_MARKER`, `PLAYER_NAME_PATTERN` and `CHAT_MARKER` in
  `packages/core/src/instance/reconcile.ts`, and the `3` and `4` mapped in
  `packages/core/src/instance/exit-code.ts`. Recheck all of them: these fail
  silently and in both directions. If the client restyles a message,
  `looksStuck` returns `false` for ever and the dashboard keeps reporting a
  wedged instance as supervised. If `CHAT_MARKER` moves, chat stops being
  filtered out of the journal and a player who types one of the stuck phrases
  in chat can drive an instance to `stuck` — a marker drift becomes an
  injection. Confirm the marker still prefixes **every** chat line the client
  emits, not merely that the codepoint is unchanged: a build that keeps `\u258c`
  but stops emitting it on one chat path opens the same hole without touching
  the constant. That filter is what separates client prose from player text in
  the journal, so it is load-bearing in the current build too, not only across a
  bump. A renumbered exit code is not safe either way, because
  `RestartPreventExitStatus=4` in `unit-template.ts` would then park the unit on
  the wrong condition.
