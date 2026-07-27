/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// AUDITARIA_HIVE_FEATURE: This entire file is part of the Hive integration.
//
// Reconnecting hive client: one WSS connection, passphrase handshake with
// relay-fingerprint pinning, app-level keepalive, exponential backoff with
// jitter. Used by BOTH the native HiveService and the hive-mcp shim — the
// two receive paths share this exact wire behavior (§2.3: clients can't
// tell Mode A and Mode B apart).

import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import {
  HIVE_PROTOCOL_VERSION,
  PING_INTERVAL_MS,
  type AckMsg,
  type AdminMsg,
  type AdminResultMsg,
  type AgentCard,
  type CardMsg,
  type EventMsg,
  type HelloMsg,
  type HiveEnvelope,
  type HubToClientMsg,
  type RosterEntry,
  type SendStateMsg,
  type TrustLevel,
} from './types.js';
import {
  deriveAuthKey,
  deriveMaster,
  fingerprintOfPublicKey,
  fromB64,
  makeAuthResponse,
  randomBytes,
  signChallenge,
  toB64,
  verifyAuthProof,
  verifyChallengeSignature,
  CHALLENGE_LEN,
} from './HiveCrypto.js';

export interface HiveClientIdentity {
  nodeId: string;
  publicKeyPem: string;
  privateKeyPem: string;
}

export interface HiveWireClientOptions {
  /** Base invite URL (https://…/<token> or http://127.0.0.1:port/<token>). */
  url: string;
  passphrase: string;
  identity: HiveClientIdentity;
  /** Card presented at every (re)connect. */
  getCard: () => AgentCard;
  /** Single-use enrollment token; sent only while unenrolled. */
  inviteToken?: string;
  /**
   * Pinned relay fingerprint. Empty on first join — the client pins whatever
   * it sees (TOFU) via onPinFingerprint and verifies on every reconnect.
   */
  pinnedFingerprint?: string;
  onPinFingerprint?: (fingerprint: string) => void;
  onLog?: (text: string) => void;
  /**
   * Alternate base URLs to try when the primary keeps failing — e.g. the
   * hub machine's current addresses from hub-info.json after a quick-tunnel
   * rotation. Queried before each reconnect attempt (from the first retry
   * on). Every candidate still runs the FULL auth (passphrase challenge-
   * response + pinned relay fingerprint), so a wrong candidate can never
   * connect us to a different hive.
   */
  getFallbackUrls?: () => string[];
  /** Fired after a successful auth on a URL different from the configured one. */
  onUrlSwitched?: (url: string) => void;
}

export type HiveClientState = 'connecting' | 'online' | 'offline' | 'stopped';

interface PendingRef {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

/** Turn a base invite URL into the concrete ws(s) endpoint. */
export function toWsUrl(baseUrl: string): string {
  const url = baseUrl.replace(/\/+$/, '');
  if (url.startsWith('https://')) return `wss://${url.slice(8)}/ws`;
  if (url.startsWith('http://')) return `ws://${url.slice(7)}/ws`;
  if (url.startsWith('wss://') || url.startsWith('ws://')) return `${url}/ws`;
  return `wss://${url}/ws`;
}

/**
 * Events:
 *  'state'    (state: HiveClientState)
 *  'deliver'  (msg: DeliverMsg)   — receiver MUST persist + ack 'delivered'
 *  'event'    (msg: EventMsg)
 *  'roster'   (roster: RosterEntry[])
 *  'receipt'  (msg: ReceiptMsg)
 *  'system'   (text: string)
 *  'welcome'  ({nickname, trust})  — after each successful auth
 *  'authfail' (reason: string)     — terminal reasons stop the reconnect loop
 */
export class HiveWireClient extends EventEmitter {
  private ws: WebSocket | undefined;
  private state: HiveClientState = 'offline';
  private stopped = false;
  private reconnectAttempt = 0;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private pingTimer: NodeJS.Timeout | undefined;
  private lastTraffic = 0;
  private refCounter = 0;
  private pendingRefs = new Map<string, PendingRef>();
  private cachedMaster: { saltB64: string; master: CryptoKey } | undefined;
  private nicknameFromHub: string | undefined;
  private trustFromHub: TrustLevel | undefined;
  private rosterCache: RosterEntry[] = [];

  constructor(private readonly options: HiveWireClientOptions) {
    super();
  }

  getState(): HiveClientState {
    return this.state;
  }

  getRoster(): RosterEntry[] {
    return this.rosterCache;
  }

  getNickname(): string | undefined {
    return this.nicknameFromHub;
  }

  getTrust(): TrustLevel | undefined {
    return this.trustFromHub;
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.setState('stopped');
    this.clearTimers();
    for (const [, p] of this.pendingRefs) {
      clearTimeout(p.timer);
      p.reject(new Error('hive client stopped'));
    }
    this.pendingRefs.clear();
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* ignore */
      }
      this.ws = undefined;
    }
  }

  private setState(state: HiveClientState): void {
    if (this.state === state) return;
    this.state = state;
    this.emit('state', state);
  }

  private log(text: string): void {
    this.options.onLog?.(text);
  }

  private clearTimers(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = undefined;
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    this.setState('offline');
    this.reconnectAttempt++;
    // Exponential backoff with jitter, capped at 60s (§2.3 network rules).
    const base = Math.min(
      60_000,
      1_000 * 2 ** Math.min(this.reconnectAttempt, 6),
    );
    const delay = base / 2 + Math.floor(Math.random() * (base / 2));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  /**
   * URL for this connection attempt. The configured URL first; from the
   * first retry on, rotate through fallback candidates (hub-info discovery)
   * so a rotated quick-tunnel hostname heals without human action.
   */
  private pickUrlForAttempt(): string {
    if (this.reconnectAttempt === 0) return this.options.url;
    const candidates = [this.options.url];
    try {
      for (const u of this.options.getFallbackUrls?.() ?? []) {
        if (u && !candidates.includes(u)) candidates.push(u);
      }
    } catch {
      /* discovery is best-effort */
    }
    return candidates[this.reconnectAttempt % candidates.length];
  }

  private currentUrl = '';

  private connect(): void {
    if (this.stopped) return;
    this.setState('connecting');
    this.currentUrl = this.pickUrlForAttempt();
    let ws: WebSocket;
    try {
      ws = new WebSocket(toWsUrl(this.currentUrl));
    } catch (e) {
      this.log(
        `hive: connect failed: ${e instanceof Error ? e.message : String(e)}`,
      );
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    let authed = false;
    const clientChallenge = randomBytes(CHALLENGE_LEN);
    // Process messages STRICTLY in arrival order. handleAuthOk awaits crypto,
    // and the hub replays queued 'deliver' frames in the same tick right after
    // 'authok' — without serialization those frames would be dispatched while
    // `authed` is still false (during the auth await) and silently dropped.
    let queue: Promise<void> = Promise.resolve();

    ws.on('message', (raw: Buffer, isBinary: boolean) => {
      if (isBinary) return;
      this.lastTraffic = Date.now();
      let msg: HubToClientMsg;
      try {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
        msg = JSON.parse(raw.toString('utf8')) as HubToClientMsg;
      } catch {
        return;
      }
      queue = queue.then(async () => {
        try {
          if (!authed) {
            if (msg.t === 'hello') {
              await this.handleHello(ws, msg, clientChallenge);
            } else if (msg.t === 'authok') {
              const ok = await this.handleAuthOk(msg, clientChallenge);
              if (ok) {
                authed = true;
                this.reconnectAttempt = 0;
                // Fallback candidate authenticated (same passphrase + same
                // pinned relay key) — adopt it as the primary and let the
                // owner persist it (heals a rotated quick-tunnel hostname).
                if (this.currentUrl && this.currentUrl !== this.options.url) {
                  this.options.url = this.currentUrl;
                  this.options.onUrlSwitched?.(this.currentUrl);
                }
                this.setState('online');
                this.emit('welcome', {
                  nickname: this.nicknameFromHub,
                  trust: this.trustFromHub,
                });
              } else {
                this.log('hive: relay verification failed — disconnecting');
                ws.close();
              }
            } else if (msg.t === 'authfail') {
              this.handleAuthFail(msg.reason);
              ws.close();
            }
            return;
          }
          this.dispatch(msg);
        } catch (e) {
          this.log(
            `hive: protocol error: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      });
    });

    ws.on('open', () => {
      this.lastTraffic = Date.now();
    });
    ws.on('close', () => {
      if (this.ws === ws) this.ws = undefined;
      this.clearPingOnly();
      this.failPendingRefs(new Error('hive connection closed'));
      this.scheduleReconnect();
    });
    ws.on('error', (e: Error) => {
      this.log(`hive: socket error: ${e.message}`);
      try {
        ws.close();
      } catch {
        /* triggers 'close' */
      }
    });
  }

  private clearPingOnly(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = undefined;
  }

  private failPendingRefs(err: Error): void {
    for (const [, p] of this.pendingRefs) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pendingRefs.clear();
  }

  private async handleHello(
    ws: WebSocket,
    hello: HelloMsg,
    clientChallenge: Uint8Array,
  ): Promise<void> {
    // Relay fingerprint pin (TOFU): reject a key change immediately, before
    // we even answer the challenge.
    const fingerprint = fingerprintOfPublicKey(hello.hubKey);
    const pinned = this.options.pinnedFingerprint;
    if (pinned && pinned !== fingerprint) {
      this.handleAuthFail(
        'relay key changed — refusing to connect (pinned fingerprint mismatch). ' +
          'If the hive was legitimately rebuilt, remove hive.json and re-join.',
      );
      ws.close();
      return;
    }
    this.pendingHubKeyFingerprint = fingerprint;
    this.pendingHubKeyPem = hello.hubKey;

    // Cache the derived master per salt so reconnects skip the 600k PBKDF2.
    if (!this.cachedMaster || this.cachedMaster.saltB64 !== hello.salt) {
      const master = await deriveMaster(
        this.options.passphrase,
        fromB64(hello.salt),
        hello.iterations,
      );
      this.cachedMaster = { saltB64: hello.salt, master };
    }
    const hkdfSalt = fromB64(hello.hkdfSalt);
    this.pendingAuthKey = await deriveAuthKey(
      this.cachedMaster.master,
      hkdfSalt,
    );
    this.pendingHubChallenge = fromB64(hello.challenge);

    const response = await makeAuthResponse(
      this.pendingAuthKey,
      this.pendingHubChallenge,
    );
    const nodeSig = signChallenge(
      this.options.identity.privateKeyPem,
      this.pendingHubChallenge,
    );
    const auth = {
      t: 'auth' as const,
      v: HIVE_PROTOCOL_VERSION,
      response,
      nodeId: this.options.identity.nodeId,
      nodePub: this.options.identity.publicKeyPem,
      nodeSig,
      clientChallenge: toB64(clientChallenge),
      card: this.options.getCard(),
      inviteToken: this.options.inviteToken,
    };
    ws.send(JSON.stringify(auth));
  }

  private pendingAuthKey: CryptoKey | undefined;
  private pendingHubChallenge: Uint8Array | undefined;
  private pendingHubKeyFingerprint: string | undefined;
  private pendingHubKeyPem: string | undefined;

  private async handleAuthOk(
    msg: {
      proof: string;
      hubSig: string;
      nickname: string;
      trust: TrustLevel;
      roster: RosterEntry[];
    },
    clientChallenge: Uint8Array,
  ): Promise<boolean> {
    if (!this.pendingAuthKey || !this.pendingHubChallenge) return false;
    // Mutual passphrase proof.
    const proofOk = await verifyAuthProof(
      this.pendingAuthKey,
      msg.proof,
      this.pendingHubChallenge,
    );
    if (!proofOk) return false;
    // Relay identity proof over OUR fresh challenge.
    if (!this.pendingHubKeyPem) return false;
    if (
      !verifyChallengeSignature(
        this.pendingHubKeyPem,
        clientChallenge,
        msg.hubSig,
      )
    ) {
      return false;
    }
    // Pin on first contact.
    if (!this.options.pinnedFingerprint && this.pendingHubKeyFingerprint) {
      this.options.pinnedFingerprint = this.pendingHubKeyFingerprint;
      this.options.onPinFingerprint?.(this.pendingHubKeyFingerprint);
    }
    // Enrollment succeeded — the single-use token must not be re-sent.
    this.options.inviteToken = undefined;
    this.nicknameFromHub = msg.nickname;
    this.trustFromHub = msg.trust;
    this.rosterCache = msg.roster ?? [];
    this.emit('roster', this.rosterCache);
    this.startPing();
    return true;
  }

  private handleAuthFail(reason: string): void {
    this.emit('authfail', reason);
    const terminal =
      /removed from the hive|bound to a different key|pinned fingerprint|invite token/i.test(
        reason,
      );
    if (terminal) {
      this.stopped = true;
      this.setState('stopped');
      this.clearTimers();
    }
    this.log(`hive: auth failed: ${reason}`);
  }

  private startPing(): void {
    this.clearPingOnly();
    this.lastTraffic = Date.now();
    // One tiny fixed app-level ping every 30s (§2.3). If the connection has
    // been silent for 3 intervals, assume it's dead and force a reconnect.
    this.pingTimer = setInterval(() => {
      const ws = this.ws;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      if (Date.now() - this.lastTraffic > PING_INTERVAL_MS * 3) {
        try {
          ws.terminate();
        } catch {
          /* triggers 'close' */
        }
        return;
      }
      try {
        ws.send(JSON.stringify({ t: 'ping' }));
      } catch {
        /* connection died; close handler recovers */
      }
    }, PING_INTERVAL_MS);
    this.pingTimer.unref?.();
  }

  private dispatch(msg: HubToClientMsg): void {
    switch (msg.t) {
      case 'pong':
        return;
      case 'deliver':
        this.emit('deliver', msg);
        return;
      case 'event': {
        const ev = msg;
        this.applyRosterEvent(ev);
        this.emit('event', ev);
        return;
      }
      case 'roster':
        this.rosterCache = msg.roster ?? [];
        this.emit('roster', this.rosterCache);
        return;
      case 'receipt':
        this.emit('receipt', msg);
        return;
      case 'send-state':
      case 'admin-result': {
        const ref = msg.ref;
        const pending = this.pendingRefs.get(ref);
        if (pending) {
          this.pendingRefs.delete(ref);
          clearTimeout(pending.timer);
          pending.resolve(msg);
        }
        return;
      }
      case 'system':
        this.emit('system', msg.text);
        return;
      case 'authfail':
        this.handleAuthFail(msg.reason);
        return;
      default:
        return;
    }
  }

  private applyRosterEvent(ev: EventMsg): void {
    if (ev.kind === 'removed' && ev.nodeId) {
      this.rosterCache = this.rosterCache.filter(
        (e) => e.card.nodeId !== ev.nodeId,
      );
      return;
    }
    if (!ev.entry) return;
    const idx = this.rosterCache.findIndex(
      (e) => e.card.nodeId === ev.entry!.card.nodeId,
    );
    if (idx >= 0) this.rosterCache[idx] = ev.entry;
    else this.rosterCache.push(ev.entry);
  }

  // ---------------- outbound API ----------------

  private nextRef(): string {
    return `r${++this.refCounter}`;
  }

  isOnline(): boolean {
    return (
      this.state === 'online' &&
      !!this.ws &&
      this.ws.readyState === WebSocket.OPEN
    );
  }

  /** Submit an envelope; resolves with the hub's per-peer send-state map. */
  sendEnvelope(env: HiveEnvelope, timeoutMs = 15_000): Promise<SendStateMsg> {
    return new Promise<SendStateMsg>((resolve, reject) => {
      const ws = this.ws;
      if (!this.isOnline() || !ws) {
        reject(new Error('hive connection is offline'));
        return;
      }
      const ref = this.nextRef();
      const timer = setTimeout(() => {
        this.pendingRefs.delete(ref);
        reject(new Error('timed out waiting for the relay send-state'));
      }, timeoutMs);
      timer.unref?.();
      this.pendingRefs.set(ref, {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
        resolve: (v) => resolve(v as SendStateMsg),
        reject,
        timer,
      });
      try {
        ws.send(JSON.stringify({ t: 'msg', ref, env }));
      } catch (e) {
        this.pendingRefs.delete(ref);
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  admin(
    op: AdminMsg['op'],
    fields: Partial<Pick<AdminMsg, 'nickname' | 'trust'>> = {},
    timeoutMs = 15_000,
  ): Promise<AdminResultMsg> {
    return new Promise<AdminResultMsg>((resolve, reject) => {
      const ws = this.ws;
      if (!this.isOnline() || !ws) {
        reject(new Error('hive connection is offline'));
        return;
      }
      const ref = this.nextRef();
      const timer = setTimeout(() => {
        this.pendingRefs.delete(ref);
        reject(new Error('timed out waiting for the relay admin result'));
      }, timeoutMs);
      timer.unref?.();
      this.pendingRefs.set(ref, {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
        resolve: (v) => resolve(v as AdminResultMsg),
        reject,
        timer,
      });
      try {
        ws.send(JSON.stringify({ t: 'admin', ref, op, ...fields }));
      } catch (e) {
        this.pendingRefs.delete(ref);
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  ack(id: string, level: AckMsg['level']): void {
    const ws = this.ws;
    if (!this.isOnline() || !ws) return;
    try {
      ws.send(JSON.stringify({ t: 'ack', id, level }));
    } catch {
      /* redelivery + dedup absorb a lost ack */
    }
  }

  updateCard(patch: CardMsg['patch']): void {
    const ws = this.ws;
    if (!this.isOnline() || !ws) return;
    try {
      ws.send(JSON.stringify({ t: 'card', patch }));
    } catch {
      /* next reconnect re-presents the full card */
    }
  }
}
