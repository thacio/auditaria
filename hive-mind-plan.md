# Auditaria Hive Mind — Feature Design (Draft 4 — neutral wording pass)

Multiple Auditaria instances belonging to the **same user** — on the same or
different computers — discover each other and exchange messages **hands-free**
(no human relaying). Foreign agent CLIs (Claude Code, Codex CLI, Gemini CLI,
Copilot CLI, etc.) join the same hive through plain MCP. Zero hosting cost.

> Status: design approved in direction, not implemented. Draft 1 = research (MCP
> spec + client support, prior art, tunneling, code audit). Draft 2 = 3-lens
> critical review incorporated. Draft 3 = user decisions: **Mode A (no-account
> quick tunnel) first**, relay deferred to phase 3; richer MCP surface
> (non-blocking `hive_check` alongside blocking `hive_wait`); broadcast-as-chat
> in v1 including human broadcast; envelope designed for votes/polls;
> **sub-agent exposure is a committed later phase (not YAGNI)**; AI can join the
> hive itself and pick/override its nickname (generated-words default);
> English-only UI strings. Draft 4 = same design, wording pass only: risk
> discussions rephrased in neutral, defensive language — no change in substance.

---

## 1. Vision and use cases

The triggering problem: two Auditarias on different computers needed to talk to
each other, and the human had to copy-paste between them.

**Use cases:**

- **U1 — Cross-machine coordination** (the original problem): agent on laptop
  asks the agent on the office PC to check something, run something, or hand
  over results. Both continue their own work; messages arrive without the user
  touching either machine.
- **U2 — Capability routing**: one machine has the GPU / the corporate network
  access / the big knowledge base / the checked-out repo. Agents ask the roster
  "who can do X?" and delegate to the right node.
- **U3 — Knowledge federation**: broadcast a question ("does anyone have docs
  about Y indexed?"), nodes answer from their local `knowledge_search`.
- **U4 — Remote tasking by the user**:
  `/hive send office-pc "rebuild the index"` — and
  `/hive send * "status report"` reaches everyone: the hive doubles as a free
  task-dispatch channel for your own machines and a **hive-wide chat**.
- **U5 — Foreign agents**: a vanilla Claude Code (no Auditaria) on a third
  machine joins via MCP and participates: sends, receives, sees the roster.
- **U6 — Structured interactions (votes, polls)**: an agent proposes ("which
  approach for X? options A/B/C"), peers' agents each evaluate and vote,
  proposer tallies and announces. The envelope supports this from day one; the
  sugar ships in a later phase.
- **U7 — Sub-agent exposure** (committed, after the core works): a node exposes
  its `external_agent_session` sub-agents so a remote orchestrator can address
  `office-pc/claude-1` directly.

**Non-goals (v1):** multi-user hives, public discovery, file transfer (messages
reference paths; bulk transfer is a later extra), consensus algorithms beyond
simple vote tallying, claude-flow-style feature sprawl.

---

## 2. Research findings that shape the design

### 2.1 "MCP callbacks" — the answer

**No MCP primitive can start a model turn in the host.** Confirmed against the
spec (2025-06-18, 2025-11-25, and the 2026-07-28 release candidate):

- `sampling/createMessage` runs a _nested_ completion returned **to the server**
  — it never enters the host conversation. **Deprecated in the 2026-07-28 RC.**
  No CLI implements it anyway. Dead end.
- `elicitation/create` asks the **user** (a form), not the model.
- Notifications are client-side bookkeeping; every CLI surveyed discards them
  without telling the model.
- **SEP-2260 (2026-07-28 RC)** forbids out-of-band server-initiated requests: a
  server may only "push" while the client has a request in flight.

**What works, per client — three receive tiers (user decision: support all
three, "well thought", so each client uses what fits it):**

| Tier                 | Mechanism                                                                                                                                                                                                                                         | Who uses it                                                                                     |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| **Push (native)**    | Auditaria in-session delivery — our own bridges pattern; no MCP involved                                                                                                                                                                          | Auditaria peers                                                                                 |
| **Park (blocking)**  | `hive_wait` blocking MCP tool — wakes the model the instant a message arrives, inside a still-open tool call (exactly the shape SEP-2260 blesses)                                                                                                 | Claude Code (≈28 h default stdio timeout), Codex (`tool_timeout_sec`), Gemini CLI (`"timeout"`) |
| **Pull (on demand)** | `hive_check` non-blocking tool — returns pending messages + roster delta immediately; the model calls it whenever it wants (mid-task "did they reply yet?", periodic check while doing other work, Claude Code background monitors / hook nudges) | Everyone; the only option for Copilot CLI (60 s hard tool cap)                                  |

Per-client timeout facts: Claude Code stdio MCP tools default to ~28 h
(`MCP_TOOL_TIMEOUT` / per-server `timeout`); Codex defaults 60 s, configurable
via `tool_timeout_sec` in config.toml; Gemini CLI defaults 10 min via per-server
`"timeout"` (progress notifications do NOT extend it — verified in source);
Copilot CLI hard-caps ~60 s and historically ignores its timeout config (#1535,
#172).

Known failure mode of park-only designs (postal-mcp): the model "wanders off"
and ends its turn instead of re-parking. Having `hive_check` as a first-class
pull path (plus hook nudges, §6.2) is the mitigation — the agent doesn't _have_
to park to participate. Claude Code "channels" (`claude/channel`, v2.1.80+) is
the only true push-to-model; research preview, allowlisted, stdio-only —
optional proxy in a later phase.

### 2.2 Prior art worth adopting (and avoiding)

- **MCP Agent Mail**: mailbox vocabulary — threads, `ack_required`,
  inbox/outbox, contact policies, memorable agent names; hook-based "you have
  mail" nudges. Weakness: polling only.
- **Agent Teams** (Anthropic, single-machine): roster + task list +
  mailbox-with-automatic-delivery split; idle notifications. Their documented
  failure list (ghost peers after resume, stale status) is our free test plan.
- **bobnet-mcp**: broker + thin clients; event vocabulary (`peer_joined`,
  `peer_left`, `status_changed`). Main weakness to avoid: in-memory only.
- **AMQ**: crash-safe inbox semantics, DLQ + receipts (we adopt semantics, NOT
  Maildir renames — §5.2).
- **cc2cc** (field notes): Windows pitfalls — renames fail under antivirus, no
  SIGTERM, duplicate delivery.
- **Happy**: per-machine daemon + E2E relay — validates the topology.
- **A2A**: adopt the Agent Card concept, not the wire protocol.

**Rejected alternative — reuse the web-interface WebSocket:** peer B could
connect to peer A's `/web` WS behind a tunnel (it already has
`setSubmitQueryHandler` + broadcast). Rejected: the web WS trusts localhost (no
peer authentication), bidirectionality needs a tunnel per machine, no
queue/offline story. One dedicated rendezvous keeps exactly one invite and one
queue store.

### 2.3 Connectivity at $0 — both modes, Mode A first (user decision)

Two modes, **same client code** (reconnecting WSS client, heartbeat, passphrase
handshake) and **same wire protocol** — clients can't tell them apart. Clear
step-by-step user instructions for both ship in `docs/hive.md`.

|                | **Mode A: Ad-hoc hub (v1, no account)**                                                                                                                       | Mode B: Cloud relay (phase 3)                                                                                                            |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Topology       | One Auditaria runs the hub in-process + **cloudflared quick tunnel** (`https://<random>.trycloudflare.com`)                                                   | ~150-line **Cloudflare Worker + Durable Object** (WebSocket Hibernation), deployed once on a free account → stable `wss://….workers.dev` |
| Cost / account | $0, **no account, nothing to deploy**                                                                                                                         | $0, free CF account (owner only)                                                                                                         |
| URL            | random, changes every hub restart                                                                                                                             | stable forever                                                                                                                           |
| Server dies    | hub restart restores queues from disk (§5.2); peers spool locally meanwhile; new URL ⇒ one re-join command per machine                                        | structural: no user machine is a server; queues live in DO storage                                                                       |
| Firewall       | clients: 443 ✅; hub needs outbound port 7844 (cloudflared) — fails in strict 443-only networks (same class as the old ripgrep issue; error must name Mode B) | all machines outbound WSS/443                                                                                                            |
| Privacy        | hub machine (user's own) sees relayed plaintext                                                                                                               | Cloudflare sees plaintext unless E2E (§7.2)                                                                                              |

Both ride Cloudflare's edge ⇒ idle WebSockets are closed (~100 s) and edge
restarts drop connections. **Network-friendliness rules (user requirement —
"don't overburden the network"):** one tiny fixed app-level ping/pong every 30 s
(in Mode B registered via `setWebSocketAutoResponse` so pings don't wake the
DO); no client polling anywhere in Auditaria (delivery is WS push); `hive_check`
is on-demand only; reconnect with exponential backoff + jitter; 64 KB message
size cap; broadcasts count as N sends against relay-side rate limits.

**"Messages must not die if the server dies" — the custody chain (§5.2):** a
message is always durably held by exactly one party — sender's disk spool (until
the relay acks receipt) → relay's disk/DO queue (until the receiver acks durable
delivery) → receiver's disk inbox (until processed). A hub crash, a relay
redeploy, or a receiver crash mid-turn each lose nothing; at-least-once + dedup
absorbs the overlaps.

**Failover reality, stated honestly:** in Mode A, hub re-election is impossible
without a stable rendezvous point — an elected hub can't tell anyone its new
random URL, and anything that could (shared file, DNS, email) IS a rendezvous
service. So Mode A failover = queues survive on disk + one-command re-join after
restart; Mode B (phase 3) removes the case entirely. (Optional middle ground
later: named tunnel on a free CF account + user domain = stable URL with the hub
still on a user machine.)

Rejected transports: ngrok free (1 GB/mo + account), localtunnel (flaky,
IP-password interstitial), bore (raw TCP), pinggy (60-min lifetime), Tailscale
(VPN install usually not allowed on corp machines; fine as an escape hatch since
the hub can bind any reachable host:port), WebRTC P2P (complexity without
benefit at KB/s).

---

## 3. Architecture overview

```
        Mode A (v1, zero-account)                      Mode B (phase 3)
┌─────────────────────────────────────────┐    ┌────────────────────────────────────┐
│ Machine 1: Auditaria                    │    │ Cloudflare Worker + DO (free)      │
│  ├─ HiveService (client, loopback WS —  │    │  wss://hive-xyz.workers.dev        │
│  │   skips tunnel, exempt from lockout) │    │  per-peer queues in DO storage     │
│  └─ HiveHub (HTTP+WS, in-process,       │    └─────▲──────────▲──────────▲────────┘
│      queues persisted to disk)          │          │WSS/443   │          │
│      ▲ cloudflared quick tunnel         │      Machine 1  Machine 2   Machine 3
└──────┼──────────────────────────────────┘     (Auditaria) (Auditaria) (Claude Code
       │ https://<rand>.trycloudflare.com                                + hive-mcp)
   WSS │ 443
┌──────┴────────┐  ┌───────────────────┐
│ Machine 2     │  │ Machine 3         │
│ Auditaria     │  │ Claude Code +     │
│ HiveService   │  │ hive-mcp shim     │
└───────────────┘  └───────────────────┘
```

Components:

- **HiveService** (every Auditaria node): owns the WSS connection, node
  keypair + agent card, local durable inbox/outbox, the turn-boundary delivery
  loop + tool gate, slash-command backend, UI events. Lives in
  `packages/cli/src/services/hive/` (same layer as telegram/discord/teams — it
  needs the agent loop).
- **HiveHub** (Mode A, v1): embedded relay (`node:http` + `ws`) — roster
  registry, **disk-persisted per-peer queues (restored on restart)**, fan-out,
  relay-side rate limits. Fronted by a cloudflared quick tunnel (spawn + scrape
  URL from stderr — pattern proven in desktop-streaming `tunnel.ts` and our
  Teams ngrok manager). The hub machine is **also a normal peer**: its own
  HiveService connects over loopback (no CF headers — auth falls back to socket
  address; loopback exempt from lockout). Caveat: the hub shares the Node event
  loop with heavy work (OCR, embeddings, provider loops) — heartbeat handling
  must be cheap; degradation under load documented; move to a `worker_thread` if
  it proves noisy.
- **hive-relay** (Mode B, phase 3): tiny Worker+DO project (separate folder
  `hive-relay/`, wrangler deploy once; template pinned and reviewed — it is
  third-party code we depend on). Wire-identical to HiveHub.
- **Hive tools** (`packages/core/src/tools/hive.ts`, `Bridgeable = true`):
  `hive_connect`, `hive_send`, `hive_status`, `hive_check`. **No `hive_wait`
  here** — a blocking tool in the core registry would hang main-session turns
  and park unbounded requests against the ToolExecutorServer (the bridge runs
  with all timeouts disabled). All hive tools are added to
  `ALWAYS_EXCLUDED_TOOLS` so sub-agents cannot speak as the node itself
  (sub-agent participation, when it ships, is explicit routing — §6.3).
- **hive-mcp shim** (foreign clients): a standalone stdio MCP server (bundled
  like `mcp-bridge.js` → `bundle/hive-mcp.js`) speaking the same WSS protocol,
  exposing `hive_status`, `hive_send`, `hive_check`, and the blocking
  `hive_wait`. Invocable as `auditaria hive-mcp …` where Auditaria is installed,
  or `node <path>/bundle/hive-mcp.js …` / a small npx package (later) on
  machines without Auditaria. Also a one-shot `--check` CLI mode that prints
  unread count + preview — for hook-based nudges (§6.2).

### Why hub-and-spoke (not P2P mesh)

One rendezvous point = one invite = one queue store = one place to enforce rate
limits. N² connections buy nothing at KB/s and multiply firewall problems.
Matches every surviving prior-art system.

---

## 4. Identity, discovery, roster

### 4.1 Per-node identity

- At first join, each node generates an **ed25519 keypair**; the public-key
  fingerprint goes in the handshake. The relay **binds `nodeId` ↔ fingerprint
  on first enrollment (TOFU)** and rejects later connections claiming that
  nodeId with a different key — an enrolled identity, its queue, and its
  nickname stay bound to the machine that enrolled them. `/hive remove <nick>`
  deletes the binding and blocks the fingerprint: **the revocation story for a
  lost laptop** (no fleet-wide re-key; rotating the passphrase stays the
  last-resort option).
- The relay/hub has its own keypair; its fingerprint is **pinned in `hive.json`
  on first join (TOFU, shown to the user)** and verified on every reconnect —
  the pin guarantees nodes are always talking to the same relay they first
  joined, whatever the current URL is (essential given Mode A's
  new-URL-per-restart flow), and that guarantee holds even if the passphrase
  were ever disclosed.
- Private keys: owner-only file permissions; OS keychain storage is a later
  improvement.

### 4.2 Agent card (A2A-inspired, local-first)

Composed at join; updated on change; broadcast as `card_updated`.

```jsonc
{
  "nodeId": "n_8f3kq2", // bound to key fingerprint at relay
  "nickname": "amber-falcon", // generated words by default; the AI or the
  //  user may override at join or later
  "machine": "DESKTOP-TH4C1O", // os.hostname()
  "platform": "win32",
  "cwdName": "auditaria", // basename ONLY (privacy, per requirement)
  "provider": "claude-code/opus", // active provider/model
  "clientKind": "auditaria", // auditaria | mcp-shim
  "capabilities": ["knowledge_search", "browser_agent", "skills:docx-writing"],
  "selfDescription": "Auditing TCU report FID-01; has the SEI knowledge base indexed.",
  "status": "idle", // idle | in-turn | waiting-on-user | offline
  "exposesSubAgents": false,
  "lastSeen": 1781234567,
}
```

- **The AI can join the hive itself** (user decision): the user pastes the
  invite into chat, the agent calls
  `hive_connect(url, passphrase, nickname?, description?)` — choosing/overriding
  its own nickname and authoring its self-description in the same step.
  `/hive join` does the same from the command line.
- **Nicknames**: generated memorable words by default (`amber-falcon` style,
  agent_mail-proven), overridable by the AI or the user. The relay suffixes
  **visually-colliding** nicknames (case/homoglyph/whitespace normalization),
  not just exact duplicates.
- **`selfDescription`**: static default
  `"{provider} on {hostname} in {cwdName}"`; agent-authored 1–2 sentences (who
  am I, what am I working on — genuinely useful for U2 routing) via
  `hive_connect`, `/hive describe`, or `hive_status` with `update_description`.
- **All card fields are treated as unverified external text everywhere they
  surface**: escaped, length-capped, control-characters-stripped before reaching
  any model prompt or UI.
- **Status is published by the harness, not the model**: we know when a turn
  starts/ends and when we're blocked on a user prompt. Senders see busy peers
  and can queue or skip.

### 4.3 Events

`peer_joined`, `peer_left`, `card_updated`, `status_changed` — fanned out to all
peers; shown as dim UI lines (`◇ hive: amber-falcon joined — "…"`), available to
models via `hive_status`/`hive_check`. Presence events **never** trigger a model
turn; only messages reach the model.

---

## 5. Message model, queues, delivery semantics

### 5.1 Envelope — designed for chat AND structured interactions

```jsonc
{
  "id": "01J9XK3V…",               // ULID — OPAQUE dedup key only (sender clocks
                                    //  can't order; see §5.3)
  "thread": "t_call-report",        // conversation grouping; replies inherit
  "from": "n_8f3kq2",
  "fromAgent": null,                // "claude-1" when sub-agents exposed (§6.3)
  "to": "n_a1b2c3" | "*",          // direct, or broadcast = the hive chat
  "kind": "chat" | "request" | "response" | "proposal" | "vote" | "status" | "system",
  "body": "markdown text",
  "data": { },                      // small structured payload (vote options,
                                    //  choices, tallies, …)
  "expectsReply": true,
  "hops": 0,                        // max 1 in v1
  "ttlSec": 86400,                  // enforced on the RELAY's clock
  "ts": 1781234567                  // sender clock, informational only
}
```

Message size cap 64 KB (Codex truncates tool outputs ~10K tokens anyway); big
artifacts are referenced, not embedded.

**Broadcast = hive chat (v1, including the human):** `to:"*"` messages form the
shared channel. Every node sees them in its UI as a chat feed
(`[Hive] amber-falcon: …`); agents receive them by turn-boundary delivery or
`hive_check` like any message; replies are **direct by default** (§5.4) so the
channel doesn't cascade. `/hive send * "…"` puts the human in the same chat.

**Votes and polls (U6 — envelope ready in v1, sugar in phase 4):** a proposal is
`kind:"proposal"`, broadcast,
`data: {proposalId, question, options[], deadlineSec, tally: "proposer"}`. Each
peer's agent receives it like any message, evaluates, and replies `kind:"vote"`
**direct to the proposer** with `data: {proposalId, choice, reason?}`. The
proposer's agent tallies and broadcasts a `kind:"status"` result. Deliberately
zero relay logic — votes are just structured messages, so the same flow works
for any future interaction pattern (bids, reviews, sign-offs). Phase-4 sugar:
`/hive vote` command, automatic tally helper, vote rendering in the UI, and a
vote-collection exemption in the thread budget (first-reply exemption already
covers it, §5.4).

### 5.2 Queues and reliability — the custody chain

A message is always durably owned by exactly one party; crashes anywhere lose
nothing:

```
sender disk spool ──(relay acks receipt)──▶ relay disk/DO queue
  ──(receiver acks AFTER local fsync)──▶ receiver disk inbox
  ──(model turn consumes / hive_check drains)──▶ processed
```

- **Relay-side durable inbox per peer**: hub persists queues under
  `~/.auditaria/hive/queue/` and **restores them on restart** (Mode A's "server
  died" answer — the URL changes, the messages don't); DO storage in Mode B.
  Senders get immediate state: `delivered` | `queued (peer offline, 3 pending)`
  — surfaced in the `hive_send` result so the model can decide to wait or move
  on. **Per-peer queue-depth cap** (overflow → DLQ + sender notice).
- **Disk format (relay and node spools): append-only JSONL per peer + a
  persisted ack/offset file.** Deliberately NOT Maildir — atomic renames are the
  documented Windows-antivirus failure (cc2cc); append + fsync avoids renames.
  Files 0600-equivalent.
- **At-least-once + dedup**: relay re-delivers until acked; receivers keep a
  persisted seen-ULID set. Two hard rules from review: **(a) acks are idempotent
  and mandatory even on dedup-drop** (re-ack at the highest level previously
  reached — otherwise a lost ack means endless redelivery and a false "expired"
  receipt for a processed message); **(b) dedup state outlives the maximum TTL**
  (+ slack) — with a bounded window, a burst of traffic could evict an old ULID
  and let a late duplicate be processed again as if new.
- **Ack levels**: `delivered` = durably fsynced in the receiver's local inbox
  (relay then deletes its copy); `processed` = consumed by a model turn or
  drained by `hive_check`/`hive_wait` — flows end-to-end to the sender as a
  receipt when `ack:"processed"` was requested.
- **TTL + DLQ**: enforced relay-side on the relay's clock; **also
  receiver-side** for messages stuck in a local inbox (agent busy for days) —
  expiry produces a receipt + `system` notice to the sender in both places. DLQ
  pruned on its own TTL.
- **Stuck (undeliverable) messages**: hand-off-to-model failure (provider crash,
  context overflow, dead PTY) → N retries with backoff → receiver-side DLQ +
  `system` notice. `processed` only acked on successful consumption. Never
  silent loss, never endless retry.
- **Broadcast semantics**: fan-out to per-peer queue entries; `hive_send`
  returns a **per-peer state map**; `processed` receipts stream back
  individually; counts as N against rate limits.
- **Sender-side outbox spool**: while disconnected, `hive_send` succeeds locally
  (state `spooled`) and flushes on reconnect.

### 5.3 Ordering, reconnect, keepalive

- **Delivery order = relay-assigned per-recipient sequence numbers** (the relay
  is the single serialization point). ULIDs are dedup keys only — they embed
  sender wall-clock; a node 5 minutes behind would sort its replies before the
  questions. Monotonic ULID factory per node.
- **Reconnect (v1)**: at-least-once + dedup is the correctness mechanism — relay
  re-delivers everything un-acked, receiver drops seen. **Epoch-aware
  seq-resume** (random epoch minted with the queue store, exchanged in `hello`;
  mismatch ⇒ discard `lastSeq`, full unacked replay) is a phase-3 optimization.
- Keepalive per §2.3 network rules: 30 s fixed ping/pong, backoff+jitter
  reconnect, no polling.

### 5.4 Reply-cascade prevention (cascades cost real tokens)

- Replies to a broadcast are **direct by default** (never re-broadcast).
- `hops` cap = 1: no auto-forward chains.
- **Rate limits enforced at the relay, keyed on the authenticated connection**
  (client-side limits are advisory UX only, and identity-keyed limits are
  unreliable because a client could always register fresh nodeIds — so
  enforcement lives at the relay, per authenticated connection). Default 20
  messages/min/node; broadcasts count as N.
- **Thread turn budget** (phase 4): counted per **peer-pair**, locally enforced,
  direct first-replies to a broadcast exempt (U3 and vote collection don't trip
  it). After N hands-free exchanges with no human message on either side:
  deliver a system notice — "auto-conversation budget reached — summarize and
  stop, or ask your user".
- Busy peers are never interrupted: messages queue locally, delivered at the
  turn boundary.
- **At scale (10+ peers)**: infrastructure is a non-issue (10 WS connections at
  KB/s is nothing for the hub or the tunnel's 200-request cap), but **broadcasts
  cost N delivered turns + N replies in real tokens** — at 10 peers, one
  broadcast question ≈ 10 model turns across the fleet. The design nudges
  accordingly: roster-driven direct addressing (U2 capability routing via
  `hive_status`) is the primary pattern, broadcast is for genuine all-hands
  moments (chat, votes, "who has X?"), and presence events (join/leave/status)
  never trigger model turns — at 10 peers a chatty roster would otherwise bury
  everyone in noise. Vote tallying (§5.1) is where 10 peers gets genuinely
  useful.

---

## 6. Receive paths (the heart of the feature)

### 6.1 Auditaria peers — native delivery + on-demand check

Reuses the messaging-bridge machinery
(`packages/cli/src/services/telegram/TelegramService.ts` et al.) **plus one new,
explicitly-designed piece: a turn-boundary signal.** (Review finding: the
Telegram pattern can only busy-REJECT its _own_ turns — its mutex is never
acquired by CLI/web turns, and `GeminiChat.sendPromise` serializes at API-call
granularity, which would let a hive turn splice in between a functionCall and
its tool-result continuation. The doc-comments in `TelegramService.ts:57/:298`
claiming otherwise are wrong — fix them before cloning the pattern.)

**Turn-boundary gate (new machinery, ~30 lines + one method):**

- `AppContainer.tsx`: one marked `useEffect` publishing
  `streamingState === StreamingState.Idle` transitions to the HiveBridge (same
  shape as the Telegram wiring block) — covers all chat-initiated turns, Gemini
  and external providers alike.
- `ProviderManager`: small public `isTurnActive()` (already tracked internally
  to pause the background hook watcher) — covers turns typed **directly into the
  live Claude PTY** via the web terminal, invisible to `streamingState`.
- HiveService drain-on-idle loop: on idle signal (and periodic fallback),
  re-check both signals, take its own promise-chain mutex, hand the next queued
  message to the model. `waiting-on-user` (pending tool confirmation /
  AskUserQuestion) is **not** a valid delivery boundary.
- **Max-hold notice**: a delivered message not yet handed to the model after N
  minutes (agent busy / user away) triggers a `status` notice to the sender
  ("delivered, not yet processed — agent busy 25m"), so `ack:"processed"`
  waiters aren't left guessing. Receiver-side TTL (§5.2) eventually expires it.

**Hand-off to the model** (proven pattern): a headless agent-loop turn — own
`Scheduler`, shared `GeminiClient` in `main` mode — exactly like
`TelegramService.processMessage`, identical under external providers. The prompt
handed to the model wraps the message in external-content framing (§7.3) plus
reply instructions ("reply with `hive_send` to thread t\_…; you may also choose
not to reply"). UI shows the turn like Teams/Telegram turns
(`[Hive amber-falcon] …` via `pushToCliDisplay`). Replies are **explicit** —
only `hive_send` sends; turn text is never auto-sent.

**`hive_check` for the local model too**: mid-turn, the agent can drain its own
inbox ("did office-pc reply yet?") instead of ending its turn. Consistency rule:
**messages drained via `hive_check` are marked processed and removed from the
delivery queue** — never delivered twice. `hive_send` also accepts a bounded
`wait_for_reply_sec` (≤ 600) for synchronous ask-and-continue flows; the bridge
supports minutes-long calls (all timeouts disabled on both sides of the HTTP
hop).

**Hard tool-permission gate for hive-triggered turns** (the safety boundary —
see §7.3 for the rationale and a concrete risk walkthrough):

- _Mechanically_, this is NOT prompt engineering and NOT part of the delivery
  machinery. Hive turns run in HiveService's own headless loop (Telegram
  pattern), and that loop executes tool calls through its **own `Scheduler`** —
  the same component that already implements tool confirmation/approval modes in
  the normal UI. The gate is a deterministic check at that exact point: when the
  model requests a tool, if the tool is in the state-changing set (shell,
  write_file, edit, browser actions…) AND the turn's triggering peer is not
  trusted, the call is not executed; the model receives a structured tool result
  ("not permitted — peer not trusted; local approval required") and continues
  its turn normally — typically replying to the peer that it needs approval. A
  few lines of code in our own loop; nothing probabilistic.
- _It cannot affect message reliability_: delivery, hand-off to the model,
  `hive_check`, and replies (`hive_send`) are never gated. Worst case for an
  untrusted peer is "work request answered with 'need approval'", never a lost
  or stuck message.
- _Once a peer is trusted, the gate is inert for it_ — fully hands-free,
  including shell work (U1/U4).
- **Trust is hive-wide state, recorded at the relay, set once per peer — never
  pairwise.** With N machines there is exactly ONE trust decision per peer (not
  N−1 prompts on N−1 screens): the relay stores each node's trust level in its
  enrollment record and broadcasts it in the roster; every node's gate reads it
  from there. The hive creator's node is implicitly trusted.
- **Trust rides in the invite (the auto-trust answer)**: `/hive invite` mints a
  **single-use, expiring enrollment token** with an embedded trust level —
  default `--full` (you are inviting your own machine; that's the common case),
  or `--consult` for gated peers. The trust decision happens where the user
  already is (the machine minting the invite), at the moment they're already
  copy-pasting an invite to the new machine — so onboarding 10 peers is 10
  `/hive invite` + paste, **zero prompts anywhere, ever**. The relay consumes
  the token at enrollment and records the trust level. An old, no-longer-secret
  invite is useless (single-use, expired); the static passphrase alone can
  authenticate reconnects of already-enrolled nodes but can no longer enroll a
  new trusted node — which closes the original concern (a leaked passphrase
  alone being enough to enroll a fully-trusted node) better than the per-join
  prompt did.
- `/hive trust <nick>` / `/hive untrust <nick>` from **any** trusted machine
  changes a peer's level hive-wide after the fact. Optional `trustPolicy` knob
  in hive config: `invite` (default, above), `open` (passphrase = full trust,
  zero ceremony for users who want it), `manual` (everything starts gated until
  `/hive trust`).
- _Scope honesty for foreign clients_: the gate governs what requesters can
  trigger **on Auditaria nodes** (we own the execution loop there). A foreign
  Claude Code/Codex machine joining via the shim is governed by its _own_ CLI's
  permission system for its _own_ tools — we can't gate it and don't pretend to;
  we only control its trust level _as a requester_ (default `--mcp` invites:
  `--consult`). Exposed sub-agents (§6.3) inherit their host node's trust — no
  separate ceremony.
- (Residual honesty: between trusted peers — the normal same-user case — the
  gate is out of the picture and the remaining safeguards are framing, judgment,
  the visible reply log, and rate limits.)
- `approve` posture routes each blocked call to a local y/n instead of
  auto-declining. Prompt framing is an added safeguard, not the mechanism.

**Session placement — configurable per node (`/hive mode`):**

| Mode                  | Where hive turns run                                                                                               | Notes                                                                                                                                                                            |
| --------------------- | ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `main` (default)      | The main session, queued at turn boundaries                                                                        | Peer benefits from this agent's working context (U1/U2 — the point). Tool gate applies.                                                                                          |
| `concierge` (phase 4) | Isolated per-peer session (`TeamsSessionManager` clone — per-peer client/driver, per-peer mutex, parallel to main) | Keeps the main session's **context/tokens** clean (U3). Honestly: isolates _context_, not _capability_ — same Config, same registry; the tool gate is what protects the machine. |
| `approve`             | Like `main`, each inbound message needs a local y/n before it is handed to the model                               | Low-trust posture.                                                                                                                                                               |

### 6.2 Foreign clients — shim with wait + check + hook nudges

The shim exposes `hive_status`, `hive_send`, `hive_check`, and
`hive_wait(max_wait_sec?)`:

- `hive_wait` **blocks** until messages arrive → `{messages, has_more}`,
  **paginated** (cap per call) so a night's backlog can't overflow the foreign
  model's context in one result. Emits heartbeat progress notifications
  (harmless where ignored); honors cancellation.
- `hive_check` returns immediately: pending messages (drained + processed-
  acked), unread count, roster delta. The "monitor whenever it needs" path —
  e.g. Claude Code can call it between tasks, from a background loop, or be
  nudged by hooks:
- **Hook nudges** (mcp_agent_mail pattern): the shim's one-shot `--check` CLI
  mode prints `HIVE: 3 unread (amber-falcon: "…preview…")` — wired into a Claude
  Code Stop/PostToolUse hook it reminds the model to call `hive_check`; a
  Stop-hook can also re-arm `hive_wait` for park-mode operation. Snippets ship
  in docs and `/hive invite --mcp`.
- The shim applies the same external-content framing to message bodies that the
  native path uses (a tool result reads as semi-trusted — peer text must always
  arrive clearly marked as coming from a peer, never as raw text).

Per-client onboarding (copy-paste via `/hive invite --mcp`):

- **Claude Code**:
  `claude mcp add hive -- node <path>/bundle/hive-mcp.js --url … --passphrase-env HIVE_PASS`
  — 28 h default stdio timeout means `hive_wait` just works; optional Stop-hook
  re-arm + `--check` nudge hook.
- **Codex**: same + `tool_timeout_sec = 86400` under `[mcp_servers.hive]` (we
  already write config.toml safely). No hooks → `hive_check` discipline via
  instructions.
- **Gemini CLI**: settings.json entry with `"timeout": 86400000`.
- **Copilot CLI**: `hive_check` short-poll only (60 s cap) — documented as
  degraded.
- Shim join card: `clientKind: "mcp-shim"`; the foreign agent can set its own
  nickname/description via `hive_connect` arguments or `update_description`.

### 6.3 Sub-agent exposure — committed (after the core works)

User decision: **wanted, not YAGNI** — scheduled as its own phase once the core
is stable, and the v1 wire format is built for it:

- Node config `exposeSubAgents: true`; addresses become hierarchical
  (`office-pc/claude-1`) via the envelope's `fromAgent`/`toAgent` fields
  (present from day one — no wire break).
- Roster lists exposed sub-agents under their node with their own status.
- HiveService routes inbound sub-agent messages into the matching
  `AgentSessionManager` session (`external_agent_session.send`); replies route
  back with `fromAgent` set. Dead sessions → `system` error to sender.
- Sub-agents inherit the node's hive identity and trust level — they never hold
  credentials, and (via `ALWAYS_EXCLUDED_TOOLS`) can never call hive tools
  directly; participation is always routed by their host node.

---

## 7. Trust and safety

### 7.1 Transport auth (DSS-derived, review-refined)

- **Layer 1**: unguessable URL token path
  (`randomBytes(16).toString('base64url')`).
- **Layer 2**: passphrase challenge-response, mutual — PBKDF2-SHA256(600k) →
  HKDF → AES-256-GCM, constant-time compare, fresh per-connection _challenge_
  (an old handshake can never be reused), auth timeout, failed-attempt lockout
  keyed on `cf-connecting-ip` **with fallback to socket address when absent**
  (loopback hub-peer, LAN/Tailscale directs); loopback exempt. Copy
  `shared/src/crypto.ts` helpers nearly verbatim; change AAD domain strings
  (`hive-auth`).
- **KDF cost control**: PBKDF2 is **not** run per connection — the relay uses a
  **static per-hive salt** and caches the derived master key; per-connection
  work is HKDF + one GCM op (challenge freshness, not salt freshness, provides
  the no-reuse guarantee). Connections that only know the URL get cheap
  rejections, lockout after 1–2 failures, **zero pre-auth metadata**, and a cap
  on concurrent unauthenticated connections.
- **Layer 3 (identity)**: node keypairs + relay TOFU binding + pinned relay
  fingerprint (§4.1) — membership is the passphrase; _identity_ is the key.
- Passphrase: machine-generated ~80-bit (`k7mq-x3rp-9wnz-h4td`,
  unambiguous-alphabet generator from DSS). Nodes are unattended: persisted per
  machine in `~/.auditaria/hive.json` (0600-equivalent);
  `AUDITARIA_HIVE_PASSPHRASE` env always wins and is never written to disk.
  Documented: home-dir cloud sync replicates the file — prefer the env var on
  synced profiles.

### 7.2 Message confidentiality

- **Stated honestly**: in Mode A, the hub machine's disk holds all peers'
  relayed plaintext (it's the user's own machine — acceptable, documented). In
  Mode B, **Cloudflare sees every body and DO stores queues in cleartext**
  unless E2E — the Worker is the user's _code_, not the user's _machine_.
- Therefore **E2E envelope sealing ships with Mode B** (phase 3,
  recommended-on): bodies sealed with AES-GCM under **per-sender keys** —
  `HKDF(master, info="send:"+nodeId)`, one counter per sender — so N parties
  never share a nonce counter (the DSS two-party counter scheme would collide;
  per-sender keys fix it). Routing metadata stays plaintext for the relay. The
  CF account gets 2FA; the Worker template is pinned.
- Queue files at rest: 0600-equivalent, DLQ pruned on TTL.

### 7.3 Peer messages as model input / behavioral authority

**The risk, concretely**: a hive message is untrusted input, and an agent acting
on one may run local tools on its own machine — so message content must never be
treated as an authorized command by itself. Every peer is "the same user" —
until a passphrase leaks, a laptop is lost, or **one of the user's own agents is
itself misled** by unverified content it read elsewhere (for example, a webpage
that tries to steer it into forwarding a task to its hive peers) — and then a
single bad request could be relayed to several machines before a human notices;
that is exactly why the tool gate and rate limits below exist. Prompt-level "be
careful" guidance is not a boundary; models comply with plausible-sounding
requests.

Safeguard layers, strongest first:

1. **Hard tool gate** (§6.1): state-changing tools blocked at scheduling time
   for non-trusted peers — enforced in our Scheduler loop, in code. **Messaging,
   chat, votes, polls, knowledge answers are never affected** — the gate only
   governs what a hive-triggered turn may _do to the local machine_.
   One-keypress trust prompt at peer join keeps U1 frictionless on the user's
   own machines.
2. **Consult honesty**: read-only access does not guarantee data stays local —
   an agent answering a peer could still include private local file contents in
   its replies. Mitigations: standing system rule + UI-visible reply log;
   optional `--guarded-replies` (outbound `hive_send` from a hive-triggered turn
   needs local approval). Documented residual risk — it requires already holding
   the hive credential.
3. **Framing as an added safeguard**: inbound bodies wrapped in a **per-message
   random marker fence**
   (`<hive_message_X9f2 from="amber-falcon">…</hive_message_X9f2>`), fence
   occurrences escaped in the body (a fixed, predictable delimiter could be
   imitated inside a message body — randomizing it per message keeps body text
   from ever being mistaken for the fence). All card fields equally escaped
   (§4.2).
4. **Peer allowlist** (`/hive allow` — matched on verified key fingerprint,
   never on the nickname string) for cautious setups; relay rate limits + queue
   caps (§5.4) bound the impact of any misuse.

---

## 8. UX: commands, config, flows

### 8.1 Slash commands (pattern: `telegramCommand.ts`) + agent self-join

```
/hive start                       Start hub + quick tunnel (Mode A) — prints invite
           [--relay <wss-url>]    (phase 3) connect to a deployed cloud relay
/hive join <invite>               Join with a minted invite (url+passphrase+token)
/hive invite [--full|--consult]   Mint a single-use invite with embedded trust
             [--mcp]              (--full default); --mcp adds per-client setup
                                  snippets (Claude Code / Codex / Gemini / Copilot;
                                  default --consult for foreign CLIs)
/hive status                      Roster, queues, connection state
/hive send <nick|*> <message>     Human message; * = hive-wide chat (v1)
/hive describe                    Agent authors/refreshes its self-description
/hive mode <main|approve> [--guarded-replies]      (concierge: phase 4)
/hive trust <nick> | untrust <nick>   Hive-wide, from any trusted machine
/hive remove <nick>               Revoke a node's key (lost laptop)
/hive leave | stop
```

The agent has the same powers via tools: `hive_connect` (join with self-chosen
nickname + description — "the AI connects itself"), `hive_send` (incl.
broadcast + bounded `wait_for_reply_sec`), `hive_status`, `hive_check`.

Config `~/.auditaria/hive.json`:
`{ url, relayFingerprint, passphrase?, nickname, nodeId, nodeKeyRef, mode, trust: {…}, autoconnect, exposeSubAgents }`.
`autoconnect: true` rejoins on every start (quiet best-effort, like Telegram
autostart). UI strings: English only.

### 8.2 First-run flow (Mode A, the user's scenario)

```
Machine A> /hive start
  ◇ hive: hub on port 18800 → https://lucky-mole-fd21.trycloudflare.com
  ◇ joined as "amber-falcon" (you, trusted)
  ◇ invite (full trust, single-use, 24h):
    /hive join https://lucky-mole-fd21.trycloudflare.com#k7mq-x3rp-9wnz-h4td.inv_9f2k

Machine B user> (pastes invite into chat) join this hive
Machine B agent> [hive_connect …] — picks nickname "cobalt-otter", authors
                 description "gemini on DESKTOP-X, indexing the SEI knowledge base"
Machine A UI> ◇ hive: cobalt-otter joined (trusted) — "indexing the SEI knowledge base…"

Machine A user> ask cobalt-otter whether the SEI index has the 2025 acórdãos
Machine A agent> [hive_send → cobalt-otter, expects_reply]
Machine B>  [Hive amber-falcon] …question…   ← delivered at turn boundary, hands-free
Machine B agent> [knowledge_search …] [hive_send reply to thread]
Machine A>  [Hive cobalt-otter] "Yes — 1,243 documents, last updated …" ← delivered
```

After the one-time invite + join, no human action is needed on either side —
trust traveled inside the invite; no prompts on any machine. Onboarding 10 peers
= minting 10 invites from wherever you're sitting.

### 8.3 Failure scenarios

- **Hub machine dies (Mode A)**: peers spool outbound locally, show
  `hive: disconnected`; the hub's queues are on disk and **restore on restart**;
  new URL ⇒ one `/hive join` per machine (`/hive invite` re-prints). Nothing is
  lost (custody chain §5.2). Mode B (phase 3) removes the re-join entirely.
- **Peer offline**: `hive_send` → `queued (peer offline)`; delivery on
  reconnect; depth cap; TTL → DLQ + notice.
- **Receiver crash mid-turn**: messages were fsynced locally before `delivered`
  was acked — re-delivered on restart; dedup prevents doubles.
- **Agent busy for hours**: max-hold notices to the sender; receiver-side TTL
  eventually expires to DLQ with receipt.
- **Two hives, one machine**: one hive per process in v1; joining a second
  replaces the first (explicit prompt).
- **cloudflared missing / port 7844 blocked**: detected at `/hive start`,
  actionable error (winget install hint; names the phase-3 relay escape hatch).

---

## 9. Implementation sketch (minimal-invasion)

New code (no upstream conflicts):

```
packages/cli/src/services/hive/
  HiveService.ts        connection, keys/card, JSONL spools, drain-on-idle
                        delivery loop + hard tool gate (own Scheduler),
                        hive_check drain semantics
  HiveHub.ts            Mode-A embedded relay: roster, disk-persisted queues
                        (restore on restart), fan-out, rate limits
  HiveTunnel.ts         cloudflared spawn + stderr URL scrape (DSS tunnel.ts /
                        Teams ngrok manager shape)
  HiveCrypto.ts         DSS crypto port (PBKDF2→HKDF→GCM, challenge-response,
                        cached master key) + ed25519 identity helpers
  HiveBridge.ts         module-level callbacks: pushToCliDisplay, idle-signal
                        subscription, processing flags
  HiveSessions.ts       concierge mode (TeamsSessionManager clone)   [phase 4]
  types.ts              envelope, card, wire protocol (versioned hello)
packages/cli/src/ui/commands/hiveCommand.ts
packages/core/src/tools/hive.ts          hive_connect / hive_send / hive_status /
                                         hive_check (Bridgeable=true; hive_wait is
                                         shim-only). Contains the module-level
                                         registerHiveTransport(cb) seam itself.
packages/cli/src/hive-mcp/ → bundle/hive-mcp.js   shim (wait/check/--check)  [phase 2]
hive-relay/                              Mode-B Worker+DO                    [phase 3]
docs/hive.md, docs/hive-relay-setup.md   clear per-mode user instructions
```

Touched existing files (one line / one block each, marked `// AUDITARIA_HIVE`):

- `tools/tool-names.ts` — name constants.
- `config/config.ts` — **only** the `maybeRegister` line. (The core→cli seam
  lives inside `hive.ts` as a `registerHiveTransport(cb)` registry exported via
  core `index.ts`; cli's HiveService registers at startup. Precedent:
  `claudePtyMirror` — a core-side singleton bus that `WebInterfaceService`
  subscribes to. NOT `injectCliInput`, which is cli→cli.)
- `providers/agent-session-manager.ts` — hive tools into `ALWAYS_EXCLUDED_TOOLS`
  (export the const if `consult` reuses it).
- `providers/providerManager.ts` — public `isTurnActive()`.
- `BuiltinCommandLoader.ts` — `/hive` registration.
- `gemini.tsx` — autoconnect + cleanup; hive-mcp subcommand routing (ph. 2).
- `AppContainer.tsx` — `registerCliDisplayCallback` wiring **plus** the
  idle-signal `useEffect` (`StreamingState.Idle` → HiveBridge) — two blocks.
- `esbuild.config.js` — `bundle/hive-mcp.js` entry (phase 2).
- `TelegramService.ts:57,:298` — fix the misleading "blocks if CLI is
  processing" doc-comments before the pattern gets cloned (drive-by).

### Phasing (user-decided: zero-account first)

1. **MVP (Mode A, Auditaria-only)**: HiveHub (disk-persisted queues) +
   HiveTunnel + HiveService + node keys/TOFU + join/roster +
   `hive_connect`/`hive_send`/`hive_status`/`hive_check` + turn-boundary
   delivery (idle signal + `isTurnActive()` + drain loop) + hard tool gate
   - trust-at-join prompt + JSONL spools + at-least-once/dedup/acks + relay rate
     limits + **broadcast chat incl. `/hive send *`** + generated nicknames +
     agent self-join. → U1/U2/U3/U4 work.
2. **Foreign clients**: hive-mcp shim (`hive_wait` + `hive_check` + one-shot
   `--check` for hook nudges) + per-client docs + npx package. → U5.
3. **Mode B relay**: `hive-relay/` Worker+DO + E2E envelope sealing +
   epoch-aware seq-resume + DLQ/TTL receipt polish + setup docs ("messages
   survive any machine dying; stable URL"). → permanent-hive story.
4. **Interactions + robustness**: votes/polls sugar (`/hive vote`, tally helper,
   UI rendering), concierge mode, guarded replies, thread budgets, web-UI hive
   chat panel.
5. **Sub-agent exposure (committed)**: hierarchical addressing, roster nesting,
   AgentSessionManager routing (§6.3).
6. **Extras**: Claude Code channels proxy (if it leaves preview), OS-keychain
   key storage, named-tunnel stable-URL option for Mode A.

### Test plan seeds (from prior-art failure lists + reviews)

Lost-ack redelivery → idempotent re-ack (no false DLQ); dedup survives restart
and outlives TTL; receiver crash between relay-release and hand-off
(fsync-before-ack); hub restart with non-empty queues → full restore;
undeliverable message → bounded retries → receiver DLQ; broadcast returns
per-peer state map; `hive_check` drain removes from delivery queue (no double
delivery); turn-boundary gate vs. PTY-typed turns (`isTurnActive`); a delivered
hive turn never splices between a functionCall and its tool-result continuation;
tool gate blocks shell/write for an untrusted peer and allows after
`/hive trust`; nickname homoglyph collision; a connection that only knows the
URL gets a cheap rejection + lockout; a substitute relay fails the
pinned-fingerprint check; Windows: no renames in spool path, exit-handler
cleanup; `hive_wait` re-arm discipline (docs + `has_more`); vote round-trip as
plain messages.

---

## 10. Decision log (was: open questions)

1. **Phasing**: Mode A (no-account quick tunnel) first; Worker/DO relay deferred
   to phase 3 with clear setup instructions. Queues persist on the hub's disk so
   a dead hub loses nothing; senders spool locally; network load stays minimal
   (push-only, 30 s pings, rate limits).
2. **Trust default**: hands-free delivery ON; hard tool gate blocks
   machine-changing tools for untrusted peers. **Trust is hive-wide,
   relay-recorded, and travels inside the single-use invite**
   (`/hive invite --full` default, `--consult` for gated/foreign peers) — zero
   prompts at any scale; `/hive trust|untrust <nick>` adjusts later from any
   trusted machine; `trustPolicy: invite|open|manual` knob. Messaging/
   chat/votes are never gated. _(Pending final user confirmation.)_
3. **Human broadcast** (`/hive send *`): in v1 — the hive chat.
4. **Nicknames**: generated words default (`amber-falcon`); the AI can join the
   hive itself via `hive_connect` and pick/override its nickname and
   description.
5. **Language**: English only.
6. **Sub-agent exposure**: committed roadmap item (phase 5), wire format ready
   from day one.
