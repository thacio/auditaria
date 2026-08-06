# Hive Engines Plan — P2P Resilience, Ledger & Consensus (research snapshot 2026-07-09)

Investigation record for evolving the Hive Mind beyond Mode-A hub-and-spoke:
(1) P2P continuity when the hub dies, (2) a "blockchain" tier — history,
audit, block-access fetch, quorum admission — and (3) pluggable engines behind
`/hive start`. All package versions/dates verified live against GitHub/npm/
crates registries on 2026-07-09 (five parallel research agents; the consensus
survey was additionally adversarially fact-checked: 22/25 claims confirmed,
3 corrected).

Scale target: a few users today → **200–400 users** later. Design bias: KISS,
zero/low deps, Windows-safe (native-module and install-time-download risk are
first-class concerns — see the ripgrep firewall history), external single
binaries acceptable (precedent: cloudflared sidecar).

---

## 1. The layer model — these concerns are separable

The single most useful synthesis result: "switch the hive engine to X" decomposes
into five independent layers, each with its own best candidate. We can adopt
them incrementally without a big-bang engine rewrite.

| Layer | Question | Best candidate | Cost | When |
|---|---|---|---|---|
| L0 Engine seam | Can engines be swapped at all? | `HiveEngine` interface extracted from `HiveWireClient` surface | ~2 days | First |
| L1 Provenance | "Is this really from hive peer X?" | Per-envelope ed25519 signatures + signed per-sender seq | ~150 LOC, 0 deps | With L0 |
| L2 Transport resilience | Survive hub death | LAN-direct + hub failover (now); hyperswarm (cross-site later) | M, 0 deps | Soon |
| L3 History ledger | Durable, queryable, auditable history; fetch = verified block access | rqlite sidecar + signed rows + hash-chain column (alt: Hypercore+hyperbee) | M | When history matters |
| L4 Attestation | k-of-n verdicts on suspect messages ("consensus on prompt injection") | Transparency-log + k-signature counting (no BFT) | ~200–400 LOC | With L3 |
| L5 Real consensus | BINDING admission rules, equivocation *prevention* | CometBFT sidecar + TypeScript ABCI app | Weeks | Only if L4 proves insufficient |

Key insight from the consensus survey: **use cases (a) durable audited history
and (b) k-of-n admission do NOT require BFT consensus.** Certificate
Transparency, WhatsApp/Messenger's Auditable Key Directory, and Sigsum all run
single-operator Merkle logs + witness cosigning at billions-of-entries scale.
The only thing that truly forces BFT is *preventing* (not detecting-with-proof)
hub equivocation while staying live under a malicious hub. Prototype L3+L4
first; adopt L5 only if binding prevention is genuinely needed.

---

## 2. Modularity audit — current state (verified against source)

**Good news: the brain is already portable.** `HiveService` (custody chain,
turn-boundary delivery loop, retry/DLQ ladder, hard tool gate, envelope build,
dedup/ack, all five hive tools incl. `hive_fetch`) touches the network ONLY
through `HiveWireClient`'s public surface. ~95% of the file is engine-agnostic.
The shim (`hiveMcpMain.ts`) is a second independent consumer of the same
surface — proof the seam is real.

**The `HiveEngine` interface** = today's `HiveWireClient` surface promoted to an
interface: `start/stop/getState/isOnline/getNickname/getTrust/getRoster/
sendEnvelope/ack/updateCard/admin` + events `state/welcome/deliver/event/roster/
receipt/system/authfail`. Injection points: `HiveService.ts:322` and
`hiveMcpMain.ts:236` (the two `new HiveWireClient` sites). **~100–150 LOC,
~2 days.**

**The honest catch — three relay-shaped assumptions the seam encodes:**
1. **Single pinned relay identity** (TOFU fingerprint of ONE relay).
2. **Relay-owned trust/enrollment roster** (`HiveHub.ts` `state.enrollments` is
   the sole authority; trust flows down via `welcome`/roster events; the tool
   gate consumes it). Deepest coupling — a mesh/chain engine needs trust
   re-homed (distributed trust ledger).
3. **Relay-assigned semantics**: per-recipient seq, offline queues + replay,
   queue-depth caps/DLQ, relay-clock TTL, broadcast fan-out, send-state
   vocabulary (`queued`/`queue-full`/`rate-limited` leaks into
   `HiveService.flushOutbox` and tool output), `RosterEntry.queued`.

Also engine-specific: `hiveCommand.ts` provisioning (`startHubAndSelfJoin` =
hub + tunnel + self-join over loopback; `autoConnectHive` branches on
`saved.hub` vs `saved.url`), and `HiveNodeConfig` fields (`url`,
`relayFingerprint`, `hub`) are relay-only → needs an `engine` discriminator +
per-engine config block + a `HiveEngineProvisioner` seam
(`provision()/join(invite)/mintInvite()/teardown()`).

**Refactor estimate**: interface + injection ~2 days; a genuine non-relay
engine ~400–600 LOC of engine-specific code (multi-week), dominated by trust
re-homing and provisioning — NOT by touching the engine-agnostic core.

Useful detail: ordering correctness today rests on **at-least-once + ULID
dedup** — both consumers ignore the relay-assigned `seq`. Keep it that way in
the engine contract (makes engines easier to write).

`hive-mind-plan.md` already anticipated exactly one swap (Mode A ↔ Mode B:
same wire protocol, hosted relay) and explicitly rejected P2P mesh at the
2–10-node design point. The 200–400 target reopens that decision.

---

## 3. Tier catalog — P2P / transport resilience (L2)

| Option | Verified | Windows/native risk | Verdict |
|---|---|---|---|
| **LAN-direct + hub failover** | n/a (all pieces already in-repo) | none, 0 deps | **Ship first.** Endpoints gossiped via hub while alive + cached; on hub loss dial direct (same auth — it's transport-agnostic). Successor order in roster; new hub URL published via signed rendezvous file in an already-synced cloud folder. Covers same-machine/LAN trivially; cross-site blip <1 min. |
| **hyperswarm / hyperdht** | hyperdht 6.33.0 pub 2026-07-08; hyperswarm 4.17.0 | LOW — sodium-native + udx-native prebuilds **bundled in tarball** (win32-x64+arm64, no install scripts, firewall-safe) | **Shortlist for cross-site/mesh.** Public DHT solves rendezvous AND NAT holepunch (incl. symmetric-NAT relay fallback) with zero infra; discovery key derivable from passphrase. Costs: 2 native addons, public-DHT metadata, Holepunch drifting to Bare runtime (Node works, not their focus). |
| WebRTC (node-datachannel 0.32.3 / werift 0.23.0 / @roamhq/wrtc 0.10.0) | all alive Apr–Mar 2026 | node-datachannel downloads prebuilds from GitHub Releases at install (**the ripgrep failure mode**); werift pure-TS | **Not recommended.** Large subsystem; STUN-only still fails symmetric NAT/CGNAT; warm-standby mesh still needs a rendezvous story; adds nothing over TCP on LAN. If ever forced: werift. |
| js-libp2p 3.3.5 (+ webrtc/dcutr/relay) | pub 2026-07-07 | inherits node-datachannel + react-native-webrtc | **Overkill, unambiguously.** 519 transitive packages; DCUtR officially limited in Node pending QUIC; circuit relay v2 = running relay infra anyway; duplicates our identity/auth/roster. |
| Static IP / port-forward WSS | n/a | none | Opportunistic config option; CGNAT kills it for many ISPs. |

**At 200–400 users**: cloud-synced rendezvous is a same-user trick (doesn't
scale to strangers); full mesh is dead (80k conns). The scaling shapes are
**federated relays** (2–5 hubs replicating envelopes — Matrix-lite, natural
evolution of `HiveHub`; requires the shared/signed trust ledger) or
**hyperswarm gossip overlay** (fully decentralized; gossip/fan-out layer DIY),
or the already-planned **Mode B** Durable Object (handles 400 WS clients
trivially; centralized-hosted).

---

## 4. Tier catalog — "blockchain": provenance, history, attestation, consensus

### 4.1 Verdict on "true blockchain via npm"
**No maintained, embeddable, real-consensus blockchain exists as an npm package
(2026).** npm "blockchains" are 2022 toys (`blockchain` 73 dl/wk, `savjeecoin`
3 dl/wk); lotion is dead (45 dl/wk); smoldot is a light client (can't host a
private chain); ganache archived Dec 2023. Real chains are Go/Rust/Java daemons
— acceptable ONLY as sidecar binaries (cloudflared pattern).

### 4.2 Provenance (L1) — signatures, not chains
"Know it's from the hive" = per-envelope ed25519 signature over canonical bytes
(from/to/thread/ulid/body-hash/ts) verified end-to-end against TOFU-pinned peer
keys + `sig=verified` stamped in the prompt fence; a **signed per-sender seq
counter** turns relay message-dropping into a detectable gap. ~150 LOC, zero
deps (`node:crypto` does ed25519 natively). Removes the relay from the trust
base for authenticity. This is also the crypto seam anticipated in `hive_fetch`
(encrypt-on-hold/decrypt-on-fetch slots into the same envelope path).

### 4.3 History / audit / block-access tier (L3)

| Candidate | Verified | Verdict |
|---|---|---|
| **rqlite** | v10.2.7 pub **2026-07-06** (3 patch releases that week); MIT; 14MB `win64.zip` per release, Windows CI'd | **Top pick.** Raft-replicated SQLite sidecar; plain HTTP+JSON API (`fetch()`, zero client deps); local-replica reads (`level=none`) = µs `hive_fetch`; **full SQL** for thread/peer/time queries — the requirement every crypto-native option fails. No built-in crypto → add our signed envelopes + `prev_hash` column + periodic signed checkpoint rows = **verifiable AND queryable ledger without BFT**. Pruning = SQL DELETE + fresh checkpoint. |
| **Hypercore + hyperbee** | 11.33.5 (2026-06-29) / 2.27.3; MIT; pure npm (sodium/rocksdb prebuilds in tarball) | **Crypto-native alternative.** Signed Merkle append-only logs; verified sparse reads map 1:1 to `hive_fetch(seq)`; `checkout` time travel; **`clear()` prunes payloads while preserving proof validity** (best pruning answer surveyed). No SQL — every query = hand-built hyperbee index; multiwriter = Autobase (roughest edge). Zero sidecars = best distribution story. Hybrid possible: hypercore log-of-record mirrored into local SQLite for queries. |
| immudb | v1.11.1 (2026-06-26), server active | **Fails on details**: official Node SDK dead since **2021** (verified reads — its entire point — would be hand-rolled gRPC+Merkle math); v1.11.x ships **no prebuilt binaries** (last Windows .exe = v1.10.0); **BUSL 1.1** license; primary/replica only (no consensus failover). |
| IPFS Kubo (+Cluster) | 0.42.0 (2026-06-08); official `kubo` npm binary-downloader maintained | Perfect fetch metaphor (CID = self-verifying block), **wrong guarantees**: content addressing proves bytes, not order/completeness — the signed log over CIDs is still DIY, at which point Kubo is expensive blob storage (~90MB bin + 200MB–1GB RAM + 2nd daemon for Cluster). Revisit only for huge-payload distribution. |
| Trillian/Tessera, Rekor v2, Sigsum | all active 2026 | Infrastructure, not embeddable stores (MySQL/multi-service; hashes not payloads; Linux-oriented). **Steal the design**: signed checkpoints + witness cosigning; optionally **anchor our checkpoint hash into the free public Rekor instance** = third-party rollback evidence at zero hosting cost. |
| dqlite | v1.18.7 | No Node bindings (years-open issue), no real Windows story. Not viable. |
| Amazon QLDB | — | **Dead** (EOL 2025-07-31). Azure Confidential Ledger: cloud/billing/MS trust root — conflicts with self-hosted ethos. |

### 4.4 Attestation without consensus (L4) — the "prompt-injection quorum"
k-of-n admission = peers' models scan an inbound message, each publishes an
ed25519-signed verdict over the message hash; a message is delivered-as-trusted
(or auto-held) once ≥k valid roster signatures accumulate. Enforcement by
**verification, not consensus** (~200–400 LOC over the L3 ledger). Precedents
at massive scale: Certificate Transparency, WhatsApp/Messenger AKD (Merkle log
+ Cloudflare witness), Sigsum k-of-witnesses. Combine with checkpoint gossip
between peers (mismatched signed checkpoints = cryptographic fork proof) and
2–3 witness-cosigning nodes. This covers the realistic same-user→400-user
threat model at ~1% of BFT's operational cost.

### 4.5 Real consensus tier (L5) — verified survey, scored /30

| Platform | Verified | Score | Verdict |
|---|---|---|---|
| **CometBFT + TS ABCI app** | v0.38.23/v0.39.3 (May 2026); **v1.x line officially abandoned** — stay on 0.38/0.39 protos | **25.5** | **Top pick if BFT is ever needed.** Node process = the ABCI state machine (varint-framed protobuf over TCP, 4 conns) → k-of-n admission enforced in OUR TypeScript. JS ABCI libs all dead → hand-roll ~300–600 LOC + ts-proto codegen (js-abci's dispatch was 63 lines). Pure-Go ~10MB binary, runs native on Windows **but official binaries stopped at v0.38.17** → we build/host our own. `create_empty_blocks=false` → idle hive ≈ zero disk. Membership via validator_updates (proven ~175–200 validators; 400 nodes → validator subset). History via `/tx_search` + `@cosmjs/tendermint-rpc` 0.39.0 (alive, May 2026). |
| Besu QBFT | 26.6.1 (2026-06-17; repo moved to besu-eth org) | 24.5 | Functionally perfect (Solidity admission contract, best Node clients — viem/ethers; zero-gas first-class; 1s blocks + empty-block suppression). **Ops kills it**: JDK 25 treadmill (~200MB), 4–6GB RAM/node, Windows officially undocumented/untested (25.3.0 broke native Windows once). Only for a handful of server-ish hubs, never per-laptop. |
| Malachite | Circle-canonical repo, active 2026-06; crate churn informal→`arc-malachitebft-*` | 21 | **Strategic watch (12–18mo).** Best-engineered post-Tendermint BFT engine (Snapchain, Circle Arc; ~780ms finality @100 validators) but Rust-library-only (we'd write the sidecar wrapper), alpha/unaudited, Windows unpioneered. |
| SmartBFT | v1.0.1 (2026-05) | 20 | Go library, Fabric 3.0's BFT orderer; more glue but the only BFT option with a trivially native single Windows .exe. Watch. |
| Commonware | v2026.5.0 | 19.5 | Younger; threshold-simplex ~200–300ms finality; audit ongoing. Watch. |
| Cosmos SDK app-chain | v0.54.3 | 22* | Dismissed with respect: end state great, but = authoring and forever maintaining a custom Go blockchain (breaking majors ~yearly). Raw CometBFT + TS ABCI gets the same consensus with the state machine in our language. |
| Fabric | v3.1.5 | 18.5 | Dismissed: Docker/WSL2-mandated, CA/MSP ceremony, 4+ daemons per participant, Raft-not-BFT by default. Opposite of an auto-spawned sidecar. |
| Substrate solo | template 2024-08 | 16.5 | Dismissed: WSL2-only (no native Windows), solochain second-class, polkadot.js in maintenance mode. |
| Iroha 2 | 2.0 still RC (2025-06) | 16.5 | Right shape (single binary + WASM executor) but never shipped stable. |
| Kwil | v0.10.2 (2025-03) | 15.5 | Requires PostgreSQL per node; stale. |
| GoQuorum | archived **2026-06-05** | 0 | **DEAD** — do not chase. |
| geth Clique | sealing removed (PoS-only client) | 0 | **DEAD** — do not chase. |
| NATS JetStream *(reference, CFT-only)* | server 2.14.3; `@nats-io/jetstream` 3.4.0; Apache-2.0 retained under CNCF post-2025 dispute | 26† | Not BFT — but single binary, first-class Windows service, superb Node clients. Relevant as a federated-relay backbone / hub crash-durability option. |

---

## 5. Scale notes (200–400 users)

- **Trust is the first casualty**: `trustPolicy:'open'` (passphrase = full
  trust) is wrong beyond same-user. Load-bearing pieces: invite-carried trust
  levels (built), per-peer trust + hard tool gate (built), and a **signed trust
  ledger** — the hash-chain applied to enrollment/trust changes ("who vouched
  for whom, when"), so the roster isn't mutable state on one laptop. Best
  value-density "moderately decentralized part"; also the prerequisite for
  federated relays (shared enrollment authority).
- **Topology**: federated relays (Matrix-lite, 2–5 hubs) or Mode B DO
  (centralized-hosted, trivially handles 400 WS) or hyperswarm overlay (most
  decentralized, most work). CometBFT validator ceiling ~200 → validator
  subset model if L5 ever ships at that scale.
- **Broadcast fan-out** needs digest/rate-limit rework at 400 regardless of
  engine.

---

## 6. Phased roadmap

| Phase | What | Cost | Status |
|---|---|---|---|
| 0 | `HiveEngine` interface + injection (+ `engine` config discriminator, provisioner seam) | ~2 days | not started |
| 1 | Per-envelope ed25519 signatures + signed per-sender seq + `sig=verified` in fence | ~150 LOC, 0 deps | not started |
| 2 | LAN-direct + hub failover + signed rendezvous file | M, 0 deps | not started |
| 3 | History ledger: rqlite sidecar + signed rows + hash-chain + checkpoints (hive_fetch → verified block access; SQL history queries) — decide rqlite vs Hypercore hybrid at build time | M | research done |
| 4 | k-of-n attestation admission + checkpoint gossip + optional Rekor anchoring | ~200–400 LOC over Phase 3 | research done |
| 5 | Trust ledger + federated relays (the 200–400 story) | multi-week | research done |
| 6 | CometBFT sidecar + TS ABCI (only if binding prevention proves necessary) | weeks | shortlisted, deferred |

Cross-cutting: hyperswarm stays the shortlisted answer for cross-site NAT
traversal / mesh if federation isn't decentralized enough.

---

*Full agent reports (with sources) from the 2026-07-09 research round: modularity
audit, P2P survey, npm-blockchain survey, verifiable-history survey, consensus
survey — session transcripts. Key version data above is inline so this doc
stands alone.*
