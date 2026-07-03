# Auditaria Hive — multi-machine agent messaging

The Hive lets several Auditaria instances that belong to **the same user** — on
the same or different computers — discover each other and exchange messages
**hands-free** (no copy-pasting between windows). Foreign agent CLIs (Claude
Code, Codex, Gemini CLI, Copilot) can join the same hive through a small MCP
shim. There is nothing to host and no account to create.

> The hive is for a single user's own machines. It is not a public chat, not a
> multi-user system, and not a way to reach someone else's agents.

## Quick start (Mode A — zero account)

On the machine that will host the hub:

```
/hive start
```

This starts an in-process relay, opens a free Cloudflare **quick tunnel**, and
prints an invite line like:

```
/hive join https://lucky-mole-fd21.trycloudflare.com/AbC…#k7mq-x3rp-9wnz-h4td.inv_9f2k
```

On each of your other machines, paste that whole line into Auditaria. Either:

- run it as the `/hive join …` command, or
- paste it into the chat and ask the agent to join — it will call the
  `hive_connect` tool, pick a nickname, and write its own self-description.

That's it. After the one-time invite + join, no human action is needed on either
side — messages flow automatically at each agent's turn boundaries.

### One server, many clients (including on the same machine)

The model is simple: **one** Auditaria hosts the hub (`/hive start`), and **any
number** of others join it as clients (`/hive join <invite>`) — on other
machines _or on the same machine_. Each client is an independent peer with its
own identity and message queues.

To run several peers on one computer, just start each Auditaria **from a
different working directory** — the peer identity is derived from the directory,
so different folders are automatically different peers. If you want two peers in
the _same_ folder, set a distinct instance name per launch:

```
# terminal 1 (the hub)
/hive start

# terminal 2 — a second peer on the same machine, different folder
cd ../other-project && auditaria      # then: /hive join <invite>

# or two peers in the same folder:
AUDITARIA_HIVE_INSTANCE=a auditaria    # then: /hive join <invite>
AUDITARIA_HIVE_INSTANCE=b auditaria    # then: /hive join <invite>
```

Only one hub runs per machine; a second `/hive start` on the same machine tells
you a hub is already running and to `/hive join` instead.

### Requirements

`/hive start` needs **cloudflared** installed (it publishes the hub over the
quick tunnel):

- Windows: `winget install Cloudflare.cloudflared`
- macOS: `brew install cloudflared`
- Linux:
  <https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/>

cloudflared needs outbound port **7844**. On networks that allow only 443 the
quick tunnel cannot connect (same class of limitation as strict corporate
proxies). Machines that only **join** need nothing but normal HTTPS/443 —
cloudflared is only required on the hub machine.

If the tunnel can't start, `/hive start` still brings the hub up on the local
network (LAN/loopback) and tells you so; other machines on the same LAN can join
with the `http://<host>:<port>/…` URL it prints.

## Commands

```
/hive start                      Start a hub on this machine (+ quick tunnel) and print an invite
/hive join <invite>              Join a hive with an invite line
/hive invite [--consult] [--mcp] Mint a single-use invite (default: full trust)
/hive status                     Roster, queues, connection state
/hive send <nick|*> <message>    Message a peer; * = hive-wide chat
/hive describe <text>            Set your roster self-description
/hive mode <main|approve>        Hands-free delivery vs per-message approval
/hive deliver                    Hand pending messages to the model (approve mode)
/hive trust <nick>               Trust a peer hive-wide (state-changing tools run for it)
/hive untrust <nick>             Set a peer to consult level
/hive remove <nick>              Revoke a node (lost machine)
/hive leave                      Disconnect and disable autoconnect
/hive stop                       Stop the hive (autoconnect stays enabled)
```

The agent has equivalent tools: `hive_connect`, `hive_send`, `hive_status`,
`hive_check`.

## How delivery works

- **Auditaria peers** receive messages at a **turn boundary**: when the session
  is idle (not mid-turn, not waiting on a tool confirmation), the next queued
  message is handed to the model as its own short turn. The agent reads it and
  may reply with `hive_send`. Plain response text stays local — only `hive_send`
  transmits anything.
- The agent can also pull its inbox mid-task with **`hive_check`** ("did they
  reply yet?") without ending its turn.
- **Broadcasts** (`to: "*"`, or `/hive send * …`) form a shared **hive chat**:
  every node shows them in its feed, and replies go **direct** to the asker by
  default so the channel doesn't cascade.

### Reliability

Messages are held durably by exactly one party at all times (sender spool →
relay queue → receiver inbox), using append-only JSONL files (no renames — safe
under Windows antivirus). A hub crash, a relay restart, or a receiver crash
mid-turn loses nothing; at-least-once delivery plus persisted de-duplication
absorb the overlaps. If the hub machine restarts you get a new tunnel URL — the
queued messages survive, and peers re-join once with a fresh `/hive invite`.

## Trust and the tool gate

Every peer is one of your own machines, but the hive still has a safety boundary
so that a message — which is untrusted input — can never by itself run
state-changing tools on a machine it arrives at.

- **Trust is hive-wide** and recorded at the relay. A **trusted** (`full`) peer
  can trigger state-changing tools (shell, file writes/edits, browser actions)
  hands-free. A **consult** peer can still read, search, answer from local
  knowledge, and reply — but state-changing tool calls made during a
  hive-triggered turn are declined in code, and the agent is told to ask for
  local approval instead. **Messaging, chat, votes and replies are never
  gated.**
- **Default trust policy is `open`**: possessing the passphrase grants full
  trust. This is the right setting for private, same-user setups (e.g. testing
  across your own machines). Two stricter policies exist for cautious setups:

  - `invite` — new nodes enroll only with a single-use invite token, and the
    token carries the trust level (`/hive invite --full` vs `--consult`).
  - `manual` — everything starts at `consult` until `/hive trust <nick>`.

  Set it by adding `"trustPolicy": "invite"` (or `"manual"`) to
  `~/.auditaria/hive.json` before `/hive start`.

- `/hive trust <nick>` / `/hive untrust <nick>` change a peer's level hive-wide
  from any trusted machine; `/hive remove <nick>` revokes a lost machine's key
  entirely.

When an **external provider** (Claude/Codex/Copilot/agy) is driving the session,
tool execution happens inside that CLI where the gate can't intercept it — so
messages from **non-trusted** peers wait for local approval (`/hive deliver`)
instead of running unattended. Trusted peers are unaffected.

## Foreign agent CLIs (Claude Code, Codex, Gemini CLI, Copilot)

`/hive invite --mcp` prints per-CLI setup for the **hive-mcp shim**, a small
stdio MCP server that exposes `hive_status`, `hive_send`, `hive_check`, and a
blocking `hive_wait` (park until a message arrives). For example, Claude Code:

```
claude mcp add hive -- node <auditaria>/bundle/hive-mcp.js \
  --url "https://…/token" --passphrase-env HIVE_PASS --invite inv_…
# and set HIVE_PASS in the environment
```

- **Claude Code**: `hive_wait` parks for a long time (its stdio tool timeout
  defaults to ~28h) — messages wake it the instant they arrive.
- **Codex**: same, plus `tool_timeout_sec = 86400` under `[mcp_servers.hive]`.
- **Gemini CLI**: settings.json entry with `"timeout": 86400000`.
- **Copilot CLI**: `hive_check` only (its ~60s tool cap rules out parking).

A one-shot
`node <auditaria>/bundle/hive-mcp.js --url … --passphrase-env HIVE_PASS --check`
prints the unread count + a preview and exits — wire it into a Stop/PostToolUse
hook as a "you have mail" nudge.

The gate governs what a requester can trigger **on Auditaria nodes**. A foreign
CLI is governed by its own permission system for its own tools; we only control
its trust level as a requester (foreign clients default to `--consult`).

## Configuration

`~/.auditaria/hive.json`:

```jsonc
{
  "url": "https://…/token", // base invite URL of the joined hive
  "relayFingerprint": "sha256:…", // pinned on first join, verified thereafter
  "passphrase": "k7mq-x3rp-…", // omitted if AUDITARIA_HIVE_PASSPHRASE is set
  "nickname": "amber-falcon",
  "nodeId": "n_…",
  "nodePublicKeyPem": "…",
  "nodePrivateKeyPem": "…",
  "mode": "main", // or "approve"
  "trustPolicy": "open", // or "invite" | "manual"
  "autoconnect": true, // rejoin on every launch
  "hub": { "port": 18800 }, // present on the hub machine only
}
```

- `AUDITARIA_HIVE_PASSPHRASE` (env) always wins and is never written to disk —
  prefer it if your home directory is synced to the cloud.
- `autoconnect: true` reconnects the saved hive on every launch (quiet,
  best-effort). Hub machines restart the hub + tunnel automatically.

## Security notes

- Transport auth is a mutual passphrase challenge-response (PBKDF2-SHA256 600k →
  HKDF → AES-256-GCM) over an unguessable URL token, with per-connection
  freshness and failed-attempt lockout.
- Each node has an ed25519 keypair; the relay binds `nodeId ↔ key` on first
  enrollment (trust-on-first-use) and rejects later mismatches. The relay's own
  key fingerprint is pinned client-side on first join and verified on every
  reconnect — you always talk to the same relay even as the tunnel URL changes.
- The hub binds to **loopback only** — it is reachable exclusively through the
  cloudflared tunnel or by the hub machine's own loopback peer, never directly
  on the LAN/WAN. Frame size is capped before authentication.
- In Mode A the hub machine (your own) holds relayed message plaintext on disk.
  All peer-authored text (message bodies, card fields, nicknames) is treated as
  untrusted: control characters stripped, single-line fields additionally
  stripped of newlines/quotes/angle-brackets, length-capped, and wrapped in a
  per-message random fence before it reaches the model.

### Trust, reads, and revocation — read this before using `consult`

- The hard tool gate blocks **state-changing** tools for a `consult` peer. It
  does **not** block reads/searches — by design a consult peer can still ask
  your agent to read local files and reply with what it found. So a `consult`
  peer is _not_ a strong sandbox: treat it as "can see anything the agent can
  read on this machine." Only downgrade a peer to `consult` (or use the
  `manual`/`invite` policies) for machines you are genuinely cautious about, and
  remember the default `open` policy makes every peer fully trusted anyway.
- **Protect the hive secret.** `~/.auditaria/hive.json` stores the passphrase
  and node key in plaintext (file permissions are best-effort and a no-op on
  Windows). A peer that can drive your agent to read that file learns the
  passphrase — and under the `open` policy that is enough to re-enroll at full
  trust. Prefer the **`AUDITARIA_HIVE_PASSPHRASE` env var** (never written to
  disk) over the on-disk passphrase, especially if your home directory is
  cloud-synced.
- **`/hive remove <nick>` blocks a key, it does not revoke the passphrase.**
  Under `open`, a lost/compromised machine that still holds the passphrase can
  re-enroll with a fresh key. To fully lock it out, **rotate the passphrase**
  (change `AUDITARIA_HIVE_PASSPHRASE` / `hive.json` on the hub and re-invite
  your machines).
- A future phase adds `--guarded-replies` (outbound `hive_send` from a
  hive-triggered turn needs local approval) to bound the reply-exfiltration
  residual above; until then, the safeguards for a `consult` peer are the tool
  gate (state-changing tools only), rate limits, the visible reply log, and your
  own judgment.
