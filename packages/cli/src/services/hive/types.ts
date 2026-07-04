/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// AUDITARIA_HIVE_FEATURE: This entire file is part of the Hive integration.
//
// Shared types for the Auditaria Hive: envelope, agent card, wire protocol
// and persisted config. See hive-mind-plan.md for the full design.

// -------------------------------------------------------------------
// Constants
// -------------------------------------------------------------------

export const HIVE_PROTOCOL_VERSION = 1;

/** Hard cap on a serialized envelope. Big artifacts are referenced, not embedded. */
export const MAX_MESSAGE_BYTES = 64 * 1024;

/** Default message TTL (enforced on the relay's clock, and receiver-side). */
export const DEFAULT_TTL_SEC = 86_400;

/** Fixed app-level keepalive so tunnel edges don't reap idle sockets (~100s). */
export const PING_INTERVAL_MS = 30_000;

/** Relay-side rate limit, per authenticated connection. Broadcasts count as N. */
export const RATE_LIMIT_PER_MIN = 20;

/** Per-peer relay queue depth cap. Overflow goes to the DLQ + sender notice. */
export const QUEUE_DEPTH_CAP = 200;

/** Unauthenticated connections must complete the handshake within this window. */
export const AUTH_TIMEOUT_MS = 15_000;

/** Failed-auth lockout: attempts within the window before the source is locked out. */
export const MAX_AUTH_FAILS = 3;
export const AUTH_FAIL_WINDOW_MS = 10 * 60_000;

/**
 * Dedup entries must outlive the maximum TTL (+ slack) — with a shorter
 * window, a late duplicate of an already-processed message could be
 * accepted again as if new.
 */
export const DEDUP_RETENTION_MS = (DEFAULT_TTL_SEC + 3_600) * 1000;

/** Default local hub port (Mode A). Falls forward to nearby ports when taken. */
export const HIVE_HUB_BASE_PORT = 18_800;

/** Invite tokens are single-use and expire. */
export const INVITE_TTL_MS = 24 * 3_600 * 1000;

/** Max hands-free wait allowed inside hive_send's wait_for_reply_sec. */
export const MAX_WAIT_FOR_REPLY_SEC = 600;

/**
 * A message delivered locally but not yet handed to the model after this
 * long triggers a "delivered, not yet processed" status notice to the sender.
 */
export const MAX_HOLD_NOTICE_MS = 25 * 60_000;

// -------------------------------------------------------------------
// Trust
// -------------------------------------------------------------------

/**
 * Trust level of a peer, hive-wide state recorded at the relay:
 * - 'full'    — hive-triggered turns may use state-changing tools hands-free.
 * - 'consult' — state-changing tools are declined at scheduling time; the
 *               model can still read, search, answer and reply.
 */
export type TrustLevel = 'full' | 'consult';

/**
 * How new enrollments receive their trust level:
 * - 'open'   — passphrase possession grants full trust. Suitable for private,
 *              same-user setups (e.g. local testing on your own machines).
 * - 'invite' — trust travels inside single-use invite tokens
 *              (/hive invite --full | --consult).
 * - 'manual' — everything starts at 'consult' until /hive trust <nick>.
 */
export type TrustPolicy = 'open' | 'invite' | 'manual';

// -------------------------------------------------------------------
// Envelope (§5.1) — designed for chat AND structured interactions
// -------------------------------------------------------------------

export type HiveMessageKind =
  | 'chat'
  | 'request'
  | 'response'
  | 'proposal'
  | 'vote'
  | 'status'
  | 'system';

export interface HiveEnvelope {
  /** ULID — OPAQUE dedup key only (sender clocks can't order; see §5.3). */
  id: string;
  /** Conversation grouping; replies inherit. */
  thread: string;
  /** Sender nodeId. */
  from: string;
  /** Sub-agent name when sub-agent exposure ships (wire-ready from day one). */
  fromAgent?: string | null;
  /** Recipient nodeId, or '*' for broadcast (the hive chat). */
  to: string;
  /** Sub-agent addressing (future phase; present so the wire never breaks). */
  toAgent?: string | null;
  kind: HiveMessageKind;
  /** Markdown text. */
  body: string;
  /** Small structured payload (vote options, choices, tallies, …). */
  data?: Record<string, unknown>;
  expectsReply?: boolean;
  /** Sender requests an end-to-end 'processed' receipt. */
  ack?: 'processed';
  /** Max 1 in v1 — no auto-forward chains. */
  hops: number;
  /** Enforced on the RELAY's clock (and receiver-side for stuck messages). */
  ttlSec: number;
  /** Sender clock, informational only. */
  ts: number;
}

// -------------------------------------------------------------------
// Agent card (§4.2) — local-first, A2A-inspired
// -------------------------------------------------------------------

export type PeerStatus = 'idle' | 'in-turn' | 'waiting-on-user' | 'offline';

export interface AgentCard {
  nodeId: string;
  /** Generated words by default; the AI or the user may override. */
  nickname: string;
  /** os.hostname() */
  machine: string;
  platform: string;
  /** basename ONLY (privacy requirement). */
  cwdName: string;
  /** Active provider/model, e.g. "claude-code/opus". */
  provider: string;
  clientKind: 'auditaria' | 'mcp-shim';
  capabilities: string[];
  /**
   * Agent-authored 1–2 sentences. Treated as unverified external text
   * everywhere it surfaces: escaped, length-capped, control chars stripped.
   */
  selfDescription: string;
  /** Published by the harness, not the model. */
  status: PeerStatus;
  exposesSubAgents: boolean;
  lastSeen: number;
}

export interface RosterEntry {
  card: AgentCard;
  trust: TrustLevel;
  online: boolean;
  /** Messages queued at the relay for this peer. */
  queued: number;
}

// -------------------------------------------------------------------
// Wire protocol — JSON text frames over a single WSS connection
// -------------------------------------------------------------------

/** Hub → client, first frame after connect. */
export interface HelloMsg {
  t: 'hello';
  v: number;
  /** Static per-hive PBKDF2 salt (the hub caches the derived master key). */
  salt: string;
  hkdfSalt: string;
  /** Fresh per-connection challenge — an old handshake can never be reused. */
  challenge: string;
  iterations: number;
  /** Hub ed25519 public key (PEM). Fingerprint is TOFU-pinned client-side. */
  hubKey: string;
}

/** Client → hub. Proves passphrase possession + node key possession. */
export interface AuthMsg {
  t: 'auth';
  v: number;
  /** GCM-sealed hub challenge under the passphrase-derived auth key. */
  response: string;
  nodeId: string;
  /** Node ed25519 public key (PEM); TOFU-bound to nodeId at first enrollment. */
  nodePub: string;
  /** ed25519 signature over the hub challenge — proves node key possession. */
  nodeSig: string;
  /** Fresh client challenge the hub must sign back (relay pinning). */
  clientChallenge: string;
  card: AgentCard;
  /** Single-use enrollment token minted by /hive invite (embeds trust). */
  inviteToken?: string;
}

/** Hub → client on successful auth. */
export interface AuthOkMsg {
  t: 'authok';
  /** Mutual passphrase proof (GCM over the hub challenge, AAD-separated). */
  proof: string;
  /** ed25519 signature over the client challenge — verifies the pinned relay. */
  hubSig: string;
  /** Nickname as registered (the hub suffixes visually-colliding nicknames). */
  nickname: string;
  trust: TrustLevel;
  roster: RosterEntry[];
}

export interface AuthFailMsg {
  t: 'authfail';
  reason: string;
}

/** Client → hub: submit an envelope for routing. */
export interface SendMsg {
  t: 'msg';
  /** Client-local correlation id for the send-state reply. */
  ref: string;
  env: HiveEnvelope;
}

/** Hub → client: per-peer outcome of a 'msg'. */
export type SendState =
  | 'delivered'
  | 'queued'
  | 'unknown-peer'
  | 'rate-limited'
  | 'queue-full'
  | 'too-large'
  | 'rejected';

export interface SendStateMsg {
  t: 'send-state';
  ref: string;
  states: Record<string, SendState>;
  error?: string;
}

/** Hub → client: deliver a queued/live envelope. Seq is relay-assigned per recipient. */
export interface DeliverMsg {
  t: 'deliver';
  env: HiveEnvelope;
  seq: number;
}

/**
 * Client → hub: acknowledge an envelope.
 * 'delivered' = durably fsynced in the local inbox (relay deletes its copy).
 * 'processed' = consumed by a model turn or drained by hive_check/hive_wait.
 * Acks are idempotent and mandatory even on dedup-drop.
 */
export interface AckMsg {
  t: 'ack';
  id: string;
  level: 'delivered' | 'processed';
}

/** Hub → sender: end-to-end receipt (when env.ack === 'processed'), or expiry/failure notice. */
export interface ReceiptMsg {
  t: 'receipt';
  id: string;
  by: string;
  level: 'processed' | 'expired' | 'failed';
  note?: string;
}

/** Client → hub: update own card (status transitions, description edits). */
export interface CardMsg {
  t: 'card';
  patch: Partial<
    Pick<
      AgentCard,
      | 'status'
      | 'selfDescription'
      | 'provider'
      | 'capabilities'
      | 'exposesSubAgents'
    >
  >;
}

/** Hub → all: presence + roster changes. Never trigger a model turn. */
export interface EventMsg {
  t: 'event';
  kind:
    | 'peer_joined'
    | 'peer_left'
    | 'card_updated'
    | 'status_changed'
    | 'trust_changed'
    | 'removed';
  entry?: RosterEntry;
  nodeId?: string;
}

/** Hub → client: full roster snapshot (sent after auth and on request). */
export interface RosterMsg {
  t: 'roster';
  roster: RosterEntry[];
}

/**
 * Client → hub: hive-wide administration, honored only from trusted peers.
 * 'invite' mints a single-use enrollment token with an embedded trust level.
 */
export interface AdminMsg {
  t: 'admin';
  ref: string;
  op: 'trust' | 'untrust' | 'remove' | 'invite';
  nickname?: string;
  trust?: TrustLevel;
}

export interface AdminResultMsg {
  t: 'admin-result';
  ref: string;
  ok: boolean;
  data?: Record<string, unknown>;
  error?: string;
}

export interface PingMsg {
  t: 'ping';
}
export interface PongMsg {
  t: 'pong';
}

/** Hub → client: human-readable operational notice (shown as a dim UI line). */
export interface SystemMsg {
  t: 'system';
  text: string;
}

export type ClientToHubMsg =
  | AuthMsg
  | SendMsg
  | AckMsg
  | CardMsg
  | AdminMsg
  | PingMsg;

export type HubToClientMsg =
  | HelloMsg
  | AuthOkMsg
  | AuthFailMsg
  | SendStateMsg
  | DeliverMsg
  | ReceiptMsg
  | EventMsg
  | RosterMsg
  | AdminResultMsg
  | PongMsg
  | SystemMsg;

// -------------------------------------------------------------------
// Persisted config (~/.auditaria/hive.json)
// -------------------------------------------------------------------

export interface HiveNodeConfig {
  /** Base invite URL (https://…/<token>), without the /ws suffix. */
  url?: string;
  /** Pinned relay key fingerprint (TOFU on first join, verified thereafter). */
  relayFingerprint?: string;
  /**
   * Persisted per machine — nodes are unattended. AUDITARIA_HIVE_PASSPHRASE
   * env always wins and is never written to disk.
   */
  passphrase?: string;
  nickname?: string;
  selfDescription?: string;
  nodeId?: string;
  nodePublicKeyPem?: string;
  nodePrivateKeyPem?: string;
  /**
   * Session placement for hive-triggered turns:
   * 'main'    — main session, queued at turn boundaries (default).
   * 'approve' — each inbound message needs a local y/n before hand-off.
   */
  mode?: 'main' | 'approve';
  /** Hub-side posture for new enrollments (see TrustPolicy). */
  trustPolicy?: TrustPolicy;
  /** Rejoin on every start (quiet best-effort, like Telegram autostart). */
  autoconnect?: boolean;
  /** Set when this machine last ran the hub — /hive start reuses it. */
  hub?: {
    port?: number;
  };
}

// -------------------------------------------------------------------
// Local delivery bookkeeping
// -------------------------------------------------------------------

/** An envelope held in the local inbox awaiting model hand-off. */
export interface InboxEntry {
  env: HiveEnvelope;
  /** Local monotonic sequence (JSONL store key). */
  seq: number;
  receivedAt: number;
  /** Nickname snapshot at receive time (roster may change before hand-off). */
  fromNickname: string;
  fromTrust: TrustLevel;
  // AUDITARIA_HIVE_FEATURE: DLQ-redrive bookkeeping. dlqRetrySafe is set when the
  // entry is moved to the local DLQ — true ONLY if the turn failed with no side
  // effect (safe to redrive once the node recovers); a tool-already-ran entry is
  // false and is never redriven (would double the side effect). dlqRedrives
  // bounds how many times a transient-fail entry is redriven before it stays
  // dead-lettered for good.
  dlqRetrySafe?: boolean;
  dlqRedrives?: number;
}

/** Result surfaced to hive_send callers. */
export interface SendResult {
  id: string;
  thread: string;
  states: Record<string, SendState | 'spooled'>;
  /** Populated when wait_for_reply_sec was used and a reply arrived in time. */
  reply?: HiveEnvelope;
}
