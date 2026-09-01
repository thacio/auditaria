/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// AUDITARIA_HIVE_FEATURE: This entire file is part of the Hive integration.
//
// hive-mcp shim (§6.2): a standalone stdio MCP server that lets FOREIGN
// agent CLIs (Claude Code, Codex, Gemini CLI, Copilot) join an Auditaria
// hive as first-class peers. Bundled to bundle/hive-mcp.js (like
// mcp-bridge.js).
//
// Every shim process claims its OWN per-instance identity, nickname,
// credentials and durable inbox (~/.auditaria/hive/shim/<key>, keyed on the
// working directory like Auditaria peers) — several foreign agents can be
// distinct hive peers at once, and a second concurrent session in the same
// directory transparently becomes `<key>_2` instead of fighting the first
// one for the hub connection.
//
// Tools exposed:
//   hive_connect              join/re-join with an invite line (runtime; persisted)
//   hive_status               roster + own identity + connection state
//   hive_send                 send/broadcast; optional wait_for_reply_sec
//   hive_check                non-blocking inbox drain (pull tier)
//   hive_wait                 BLOCKING park until messages arrive (park tier)
//   hive_describe             update the roster self-description
//   hive_leave                disconnect + disable auto-reconnect
//
// hive_wait exists ONLY here: foreign clients tolerate long tool calls
// (Claude Code ~28h stdio default; Codex/Gemini via timeout config; Copilot
// is documented as hive_check-only with its 60s cap).
//
// Registration needs NO arguments — e.g. for Claude Code:
//   claude mcp add --scope user hive -- node <auditaria>/bundle/hive-mcp.js
// then paste the /hive invite line into the agent's chat and it calls
// hive_connect. Legacy arg-based registration still works:
//   node hive-mcp.js [--url <https://…/token>] [--passphrase X | --passphrase-env VAR]
//        [--invite inv_…] [--nickname name] [--description text]
//        [--instance name] [--check]
//
// One-shot mode: `--check` prints "HIVE: N unread (nick: preview…)" and
// exits — wire it into a Stop/PostToolUse hook as a "you have mail" nudge.
// Safe beside a LIVE shim: it peeks the running instance's inbox read-only
// instead of stealing its identity (the hub displaces duplicate nodeIds).
//
// Watcher mode: `--watch [--instance key]` BLOCKS (silent, read-only inbox
// poll beside the live shim) and EXITS the moment any message/broadcast/vote
// lands, printing the unread summary. Exit-on-mail is the wake-up mechanism
// for agents whose harness notifies them when a background command finishes
// (e.g. Claude Code's Bash run_in_background / Monitor): start the watcher,
// keep working, get woken, hive_check, restart the watcher. It never claims
// the instance or touches the hub, and ends itself when the live shim goes
// away. The MCP server advertises this recipe via its `instructions` field.

import * as os from 'node:os';
import * as path from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import {
  CONSUME_STALE_MS,
  DEDUP_RETENTION_MS,
  DEFAULT_TTL_SEC,
  MAX_MESSAGE_BYTES,
  MAX_WAIT_FOR_REPLY_SEC,
  type AgentCard,
  type HiveEnvelope,
  type HubInfoFile,
  type InboxEntry,
  type RosterEntry,
  type TrustLevel,
} from '../services/hive/types.js';
import {
  hubInfoFallbackUrls,
  parseInvite,
} from '../services/hive/hivePolicy.js';
import { getHubInfoPath, releasePidLock } from '../services/hive/hivePaths.js';
import {
  acquireShimInstance,
  discoverLocalHive,
  envPassphrase,
  legacyShimNotice,
  loadShimConfig,
  peekJsonlPending,
  resolveShimConnection,
  saveShimConfig,
  shimInstanceHolder,
  shimInstanceKey,
  shimInstancePaths,
  type ShimConnection,
  type ShimInstance,
  type ShimInstanceConfig,
} from '../services/hive/hiveShim.js';
import {
  formatObjectOpResult,
  type HiveObjectOpParams,
  type HiveObjectRecord,
} from '../services/hive/hiveObjects.js';
import {
  generateIdentityKeyPair,
  generateNickname,
  makeFenceMarker,
  makeNodeId,
  makeUlid,
  sanitizeExternalText,
  sanitizeInline,
} from '../services/hive/HiveCrypto.js';
import {
  JsonlQueueStore,
  SeenStore,
  readJsonFile,
} from '../services/hive/HiveStore.js';
import { HiveWireClient } from '../services/hive/HiveWireClient.js';

/** Message kinds accepted for display (peer-controlled → validate). */
const VALID_MSG_KINDS = new Set<string>([
  'chat',
  'request',
  'response',
  'proposal',
  'vote',
  'status',
  'system',
]);

// -------------------------------------------------------------------
// Args
// -------------------------------------------------------------------

interface ShimArgs {
  url?: string;
  passphrase?: string;
  passphraseFromEnv: boolean;
  invite?: string;
  nickname?: string;
  description?: string;
  instance?: string;
  oneShotCheck: boolean;
  watch: boolean;
  loop: boolean;
}

function parseArgs(argv: string[]): ShimArgs {
  const args: ShimArgs = {
    oneShotCheck: false,
    passphraseFromEnv: false,
    watch: false,
    loop: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '--url':
        args.url = next();
        break;
      case '--passphrase':
        args.passphrase = next();
        break;
      case '--passphrase-env': {
        const envName = next();
        const val = envName ? process.env[envName] : undefined;
        if (val) {
          args.passphrase = val;
          args.passphraseFromEnv = true;
        }
        break;
      }
      case '--invite':
        args.invite = next();
        break;
      case '--nickname':
        args.nickname = next();
        break;
      case '--description':
        args.description = next();
        break;
      case '--instance':
        args.instance = next();
        break;
      case '--check':
        args.oneShotCheck = true;
        break;
      case '--watch':
        args.watch = true;
        break;
      case '--loop':
        args.loop = true;
        break;
      default:
        break;
    }
  }
  return args;
}

// -------------------------------------------------------------------
// Unread summary + watcher mode
// -------------------------------------------------------------------

/** One-line "you have mail" summary shared by --check and --watch. */
function unreadSummary(count: number, first?: InboxEntry, notices = 0): string {
  if (count === 0 || !first) {
    return notices > 0
      ? `HIVE: no unread messages (${notices} delivery notice(s) pending — hive_check reads them)`
      : 'HIVE: no unread messages';
  }
  const kindRaw = String(first.env?.kind ?? 'chat');
  const kind =
    VALID_MSG_KINDS.has(kindRaw) && kindRaw !== 'chat' ? ` [${kindRaw}]` : '';
  const preview = sanitizeExternalText(first.env?.body ?? '', 80).replace(
    /\n/g,
    ' ',
  );
  const from = sanitizeInline(first.fromNickname ?? '?', 60);
  const noteSuffix = notices > 0 ? ` (+${notices} notice(s))` : '';
  return `HIVE: ${count} unread${noteSuffix} (${from}${kind}: "${preview}") — call hive_check to read`;
}

/** Split pending entries into actionable mail vs status/system notices. */
function splitActionable(values: InboxEntry[]): {
  actionable: InboxEntry[];
  notices: number;
} {
  const actionable = values.filter(
    (v) => v.env?.kind !== 'status' && v.env?.kind !== 'system',
  );
  return { actionable, notices: values.length - actionable.length };
}

const WATCH_POLL_MS = 2_000;

/**
 * `--watch`: silent read-only poll of the LIVE shim's inbox; exits (printing
 * the summary) the instant anything is unread — a direct message, broadcast,
 * vote, anything. Never claims the instance, never touches the hub, and ends
 * itself when the live shim goes away (the messages stop landing locally).
 *
 * `--watch --loop`: stays ALIVE instead — prints one summary line whenever
 * the unread count RISES (and resets after the agent drains), so a harness
 * that can watch a background command's output for a pattern (e.g. Claude
 * Code's Monitor on "HIVE:") gets a wake-up per message without respawning
 * the watcher each time. Still ends itself when the live shim goes away.
 */
async function runWatch(instanceArg?: string, loop = false): Promise<never> {
  const key = shimInstanceKey(instanceArg);
  const paths = shimInstancePaths(key);
  let lastCount = 0;
  for (;;) {
    const holder = shimInstanceHolder(key);
    if (!holder || holder === process.pid) {
      process.stdout.write(
        `HIVE: watch ended — no live hive-mcp session holds instance "${key}" ` +
          `(messages stay queued at the relay until one connects; use --check to poll the relay directly)\n`,
      );
      process.exit(0);
    }
    const { values } = peekJsonlPending<InboxEntry>(paths.inboxPath);
    // Wake only on ACTIONABLE mail (a real message/vote for this agent) —
    // delivery/status notices don't justify interrupting work; they surface
    // at the next real drain and in the "+N notice(s)" suffix.
    const { actionable, notices } = splitActionable(values);
    if (actionable.length > 0 && !loop) {
      process.stdout.write(
        `${unreadSummary(actionable.length, actionable[0], notices)}\n`,
      );
      process.exit(0);
    }
    if (loop) {
      if (actionable.length > lastCount) {
        process.stdout.write(
          `${unreadSummary(actionable.length, actionable[0], notices)}\n`,
        );
      }
      lastCount = actionable.length;
    }
    await new Promise((resolve) => setTimeout(resolve, WATCH_POLL_MS));
  }
}

// -------------------------------------------------------------------
// Main
// -------------------------------------------------------------------

interface ReplyWaiter {
  thread: string;
  /** nodeId of the peer we sent to; undefined for a broadcast wait. */
  expectedFrom: string | undefined;
  resolve: (env: HiveEnvelope | undefined) => void;
  timer: NodeJS.Timeout;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const legacyNote = legacyShimNotice();
  if (legacyNote) process.stderr.write(`${legacyNote}\n`);

  // ---------------- watcher mode (blocks; exits on mail) ----------------
  if (args.watch) {
    await runWatch(args.instance, args.loop); // never returns
  }

  // ---------------- one-shot --check beside a LIVE shim ----------------
  // The running MCP server owns the instance's identity + connection; a
  // second connection with the same nodeId would displace it at the hub.
  // Peek its durable inbox read-only instead (undrained == unread).
  if (args.oneShotCheck) {
    const baseKey = shimInstanceKey(args.instance);
    const holder = shimInstanceHolder(baseKey);
    if (holder && holder !== process.pid) {
      const paths = shimInstancePaths(baseKey);
      const { count, first } = peekJsonlPending<InboxEntry>(paths.inboxPath);
      process.stdout.write(`${unreadSummary(count, first)}\n`);
      process.exit(0);
    }
  }

  // ---------------- claim a per-instance identity ----------------
  const baseKey = shimInstanceKey(args.instance);
  const inst: ShimInstance | undefined = acquireShimInstance(baseKey);
  if (!inst) {
    process.stderr.write(
      `hive-mcp: could not claim a hive instance for "${baseKey}" (all slots locked by live processes)\n`,
    );
    process.exit(1);
  }
  if (inst.key !== baseKey) {
    process.stderr.write(
      `hive-mcp: instance "${baseKey}" is held by another live session — running as "${inst.key}" (own identity + inbox)\n`,
    );
  }
  process.on('exit', () => releasePidLock(inst.lockPath));
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => process.exit(0));
  }

  const cfg: ShimInstanceConfig = loadShimConfig(inst);
  if (!cfg.nodeId || !cfg.nodePublicKeyPem || !cfg.nodePrivateKeyPem) {
    const keys = generateIdentityKeyPair();
    cfg.nodeId = makeNodeId();
    cfg.nodePublicKeyPem = keys.publicKeyPem;
    cfg.nodePrivateKeyPem = keys.privateKeyPem;
  }
  if (args.nickname) cfg.nickname = sanitizeInline(args.nickname, 60);
  if (!cfg.nickname) cfg.nickname = generateNickname();
  if (args.description) {
    cfg.selfDescription = sanitizeInline(args.description, 240);
  }
  saveShimConfig(inst, cfg);

  const inbox = new JsonlQueueStore<InboxEntry>(inst.inboxPath);
  const seen = new SeenStore(inst.seenPath, DEDUP_RETENTION_MS);
  inbox.load();
  seen.load();

  let lastConsumedTs = 0;
  let client: HiveWireClient | undefined;
  /** Last connection-level failure, surfaced in tool results (not just stderr). */
  let lastConnError = '';

  // Listeners waiting inside a blocking hive_wait call.
  const waitResolvers = new Set<() => void>();
  // hive_send wait_for_reply_sec parkers (mirrors HiveService semantics).
  const replyWaiters = new Set<ReplyWaiter>();

  const buildCard = (): AgentCard => ({
    nodeId: cfg.nodeId!,
    nickname: cfg.nickname!,
    machine: os.hostname(),
    platform: process.platform,
    cwdName: path.basename(process.cwd()),
    provider: 'mcp-shim',
    clientKind: 'mcp-shim',
    capabilities: [],
    selfDescription:
      cfg.selfDescription ?? `foreign agent via hive-mcp on ${os.hostname()}`,
    status: 'idle',
    exposesSubAgents: false,
    lastSeen: Date.now(),
    deliveryMode: 'manual', // AUDITARIA_HIVE_FEATURE (shim is inherently pull-only)
    lastConsumedTs,
  });

  const handleDeliver = (
    c: HiveWireClient,
    msg: { env: HiveEnvelope; seq: number },
  ): void => {
    const env = msg.env;
    if (!env?.id) return;
    if (seen.has(env.id)) {
      c.ack(env.id, 'delivered');
      return;
    }
    // A parked wait_for_reply consumes its reply directly (same matching as
    // HiveService: thread AND expected sender AND a genuine reply kind).
    const isReplyKind = env.kind !== 'status' && env.kind !== 'system';
    const waiter = isReplyKind
      ? [...replyWaiters].find(
          (w) =>
            w.thread === env.thread &&
            (w.expectedFrom === undefined || w.expectedFrom === env.from),
        )
      : undefined;
    if (waiter) {
      seen.add(env.id); // durable BEFORE the delivered ack
      c.ack(env.id, 'delivered');
      c.ack(env.id, 'processed');
      lastConsumedTs = Date.now();
      c.updateCard({ lastConsumedTs });
      replyWaiters.delete(waiter);
      clearTimeout(waiter.timer);
      waiter.resolve(env);
      return;
    }
    const fromEntry = c.getRoster().find((e) => e.card.nodeId === env.from);
    // Custody: fsync BEFORE the delivered ack.
    inbox.enqueue({
      env,
      seq: 0,
      receivedAt: Date.now(),
      fromNickname: sanitizeExternalText(
        fromEntry?.card.nickname ?? env.from,
        60,
      ),
      fromTrust: fromEntry?.trust ?? 'consult',
    });
    seen.add(env.id);
    c.ack(env.id, 'delivered');
    for (const resolve of waitResolvers) resolve();
  };

  const startClient = (conn: ShimConnection): HiveWireClient => {
    if (client) {
      try {
        client.stop();
      } catch {
        /* ignore */
      }
      client = undefined;
    }
    const c = new HiveWireClient({
      url: conn.url,
      passphrase: conn.passphrase,
      identity: {
        nodeId: cfg.nodeId!,
        publicKeyPem: cfg.nodePublicKeyPem!,
        privateKeyPem: cfg.nodePrivateKeyPem!,
      },
      inviteToken: conn.inviteToken,
      pinnedFingerprint: cfg.relayFingerprint,
      onPinFingerprint: (fp) => {
        cfg.relayFingerprint = fp;
        saveShimConfig(inst, cfg);
      },
      // Same-machine auto-heal: quick-tunnel hostnames rotate on hub restart;
      // hub-info.json points at the same hive's new address (token-matched;
      // auth still fully validates).
      getFallbackUrls: () =>
        hubInfoFallbackUrls(
          cfg.url ?? conn.url,
          readJsonFile<HubInfoFile>(getHubInfoPath()),
        ),
      onUrlSwitched: (url) => {
        cfg.url = url;
        saveShimConfig(inst, cfg);
      },
      getCard: buildCard,
      onLog: (text) => {
        if (/socket error|auth failed|connect failed/i.test(text)) {
          lastConnError = text.replace(/^hive:\s*/, '');
        }
        process.stderr.write(`${text}\n`);
      },
    });
    c.on('welcome', (info: { nickname?: string }) => {
      lastConnError = '';
      if (info.nickname && info.nickname !== cfg.nickname) {
        cfg.nickname = info.nickname;
        saveShimConfig(inst, cfg);
      }
    });
    c.on('deliver', (msg: { env: HiveEnvelope; seq: number }) =>
      handleDeliver(c, msg),
    );
    c.on('authfail', (reason: string) => {
      // Never exit: the agent can retry hive_connect with a corrected invite.
      process.stderr.write(`hive-mcp: auth failed: ${reason}\n`);
    });
    c.start();
    client = c;
    return c;
  };

  /** Resolve on the first auth outcome: welcome, authfail, or timeout. */
  const waitForAuth = (
    c: HiveWireClient,
    timeoutMs: number,
  ): Promise<{ ok: boolean; reason?: string; timedOut?: boolean }> => {
    if (c.isOnline()) return Promise.resolve({ ok: true });
    return new Promise((resolve) => {
      const cleanup = () => {
        clearTimeout(timer);
        c.off('welcome', onWelcome);
        c.off('authfail', onFail);
      };
      const onWelcome = () => {
        cleanup();
        resolve({ ok: true });
      };
      const onFail = (reason: string) => {
        cleanup();
        resolve({ ok: false, reason });
      };
      const timer = setTimeout(() => {
        cleanup();
        resolve({ ok: false, timedOut: true });
      }, timeoutMs);
      timer.unref?.();
      c.on('welcome', onWelcome);
      c.on('authfail', onFail);
    });
  };

  // ---------------- startup auto-join ----------------
  // Sources, strongest first: registration args (legacy) → saved instance
  // config → machine-local hub discovery + env passphrase. hive_leave sets
  // autojoin=false, which only explicit args override.
  const startupConn = resolveShimConnection({
    argUrl: args.url,
    argPassphrase: args.passphrase,
    argPassphraseFromEnv: args.passphraseFromEnv,
    argInvite: args.invite,
    cfg,
    envPass: envPassphrase(),
    hubInfo: readJsonFile<HubInfoFile>(getHubInfoPath()),
  });
  if (startupConn && (cfg.autojoin !== false || !!args.url)) {
    cfg.url = startupConn.url;
    if (startupConn.persistPassphrase) cfg.passphrase = startupConn.passphrase;
    cfg.autojoin = true;
    saveShimConfig(inst, cfg);
    startClient(startupConn);
  }

  // ---------------- one-shot --check mode (no live holder) ----------------
  if (args.oneShotCheck) {
    if (!client) {
      process.stdout.write(
        'HIVE: not joined (no saved hive credentials for this directory — ask the agent to call hive_connect with an invite line)\n',
      );
      process.exit(0);
    }
    // Give the connection a moment to replay queued deliveries, then print
    // the unread count + preview WITHOUT consuming anything.
    await new Promise((resolve) => setTimeout(resolve, 4_000));
    const entries = inbox.entries();
    process.stdout.write(
      `${unreadSummary(entries.length, entries[0]?.value)}\n`,
    );
    client.stop();
    inbox.dispose();
    seen.dispose();
    process.exit(0);
  }

  // ---------------- helpers shared by tools ----------------

  const formatRosterLine = (): string => {
    if (!client) {
      return 'Connection: not joined — call hive_connect with the invite line the user gives you.';
    }
    const roster = client.getRoster();
    const online = roster.filter((e) => e.online).length;
    return `Connection: ${client.getState()}. Roster: ${online}/${roster.length} peers online.`;
  };

  const formatRoster = (roster: RosterEntry[]): string => {
    if (roster.length === 0) return 'No peers enrolled.';
    return roster
      .map((entry) => {
        const c = entry.card;
        const isSelf = c.nodeId === cfg.nodeId;
        // Advisory presence with age: "last check 12m ago" beats a binary flag
        // when deciding whether a peer will see a message soon.
        const consumeAge = c.lastConsumedTs
          ? Math.round((Date.now() - c.lastConsumedTs) / 60_000)
          : undefined;
        const bits = [
          entry.online ? c.status : 'offline',
          `trust=${entry.trust}`,
          c.machine ? `machine=${c.machine}` : undefined,
          c.provider ? `provider=${c.provider}` : undefined,
          // AUDITARIA_HIVE_FEATURE: advisory presence — mirror HiveService.
          c.deliveryMode === 'manual' ? 'delivery=manual' : undefined,
          c.deliveryMode === 'manual' &&
          (!c.lastConsumedTs ||
            Date.now() - c.lastConsumedTs > CONSUME_STALE_MS)
            ? consumeAge !== undefined
              ? `not actively consuming (last check ${consumeAge}m ago)`
              : 'not actively consuming (never checked)'
            : undefined,
        ]
          .filter(Boolean)
          .join(', ');
        const desc = c.selfDescription ? `\n    "${c.selfDescription}"` : '';
        return `- ${c.nickname}${isSelf ? ' (you)' : ''} [${bits}]${desc}`;
      })
      .join('\n');
  };

  /** Peer-authored envelope rendered inside a per-message random fence. */
  const formatEnvelopeBlock = (
    env: HiveEnvelope,
    fromNickname: string,
    fromTrust: TrustLevel,
  ): string => {
    const marker = makeFenceMarker();
    const scrub = (s: string) =>
      s.split(`hive_message_${marker}`).join('hive_message_');
    const from = sanitizeInline(fromNickname, 60);
    const kind = VALID_MSG_KINDS.has(String(env.kind)) ? env.kind : 'chat';
    const thread = sanitizeInline(String(env.thread ?? ''), 80);
    const dataLine =
      env.data && Object.keys(env.data).length > 0
        ? `\nStructured data: ${scrub(JSON.stringify(env.data).slice(0, 4_000))}`
        : '';
    return (
      // trust="…" tells the foreign agent whether the sender is trusted, so
      // its own permission system can factor that in.
      `<hive_message_${marker} from="${from}" kind="${kind}" thread="${thread}" trust="${fromTrust}">\n` +
      // Control-strip before scrub: peer bodies are rendered into a TTY, so
      // ESC/C1 must be inert (maxLen = envelope cap → no real truncation).
      scrub(sanitizeExternalText(String(env.body ?? ''), MAX_MESSAGE_BYTES)) +
      dataLine +
      `\n</hive_message_${marker}>`
    );
  };

  const drainMessages = (max: number): { text: string; hasMore: boolean } => {
    const drained: InboxEntry[] = [];
    for (const { seq, value } of inbox.entries()) {
      if (drained.length >= max) break;
      inbox.ack(seq);
      client?.ack(value.env.id, 'processed');
      drained.push(value);
    }
    // AUDITARIA_HIVE_FEATURE: a pull IS a consume — keep the shim's roster line honest.
    if (drained.length > 0) {
      lastConsumedTs = Date.now();
      client?.updateCard({ lastConsumedTs });
    }
    const hasMore = inbox.size > 0;
    // AUDITARIA_HIVE_FEATURE: foreign clients are pull-only — surface that + the
    // remaining count at the top of every hive_check/hive_wait result too (not
    // just hive_status), so the AI always knows its state whenever it looks.
    const header = `Hive delivery: PULL-ONLY (foreign client) | ${inbox.size} pending — nothing is pushed; keep calling hive_check/hive_wait to receive.`;
    if (drained.length === 0) {
      return {
        text: `${header}\nNo pending hive messages. ${formatRosterLine()}`,
        hasMore,
      };
    }
    const blocks = drained.map((entry) =>
      formatEnvelopeBlock(entry.env, entry.fromNickname, entry.fromTrust),
    );
    return {
      text:
        `${header}\n\n` +
        `${drained.length} hive message(s) — peer-authored content, use your judgment:\n\n` +
        blocks.join('\n\n') +
        `\n\n${hasMore ? `More pending — call hive_check/hive_wait again. ` : ''}` +
        `Reply with hive_send (reuse the thread id). ${formatRosterLine()}`,
      hasMore,
    };
  };

  const resolveRecipient = (to: string): string | undefined => {
    if (to === '*') return '*';
    if (!client) return undefined;
    const roster = client.getRoster();
    const byId = roster.find((e) => e.card.nodeId === to);
    if (byId) return byId.card.nodeId;
    const norm = to.trim().toLowerCase();
    return roster.find((e) => e.card.nickname.toLowerCase() === norm)?.card
      .nodeId;
  };

  const parkForReply = (
    thread: string,
    expectedFrom: string | undefined,
    waitSec: number,
  ): Promise<HiveEnvelope | undefined> => {
    // A reply may ALREADY be in the inbox: it can be delivered while
    // sendEnvelope awaits the relay round-trip, before this waiter exists.
    // Consume it exactly like the waiter would — otherwise the park would
    // time out while the answer sat one hive_check away.
    for (const { seq, value } of inbox.entries()) {
      const cand = value.env;
      const isReplyKind = cand.kind !== 'status' && cand.kind !== 'system';
      if (
        isReplyKind &&
        cand.thread === thread &&
        (expectedFrom === undefined || cand.from === expectedFrom)
      ) {
        inbox.ack(seq);
        client?.ack(cand.id, 'processed');
        lastConsumedTs = Date.now();
        client?.updateCard({ lastConsumedTs });
        return Promise.resolve(cand);
      }
    }
    return new Promise((resolve) => {
      const waiter: ReplyWaiter = {
        thread,
        expectedFrom,
        resolve,
        timer: setTimeout(() => {
          replyWaiters.delete(waiter);
          resolve(undefined);
        }, waitSec * 1000),
      };
      waiter.timer.unref?.();
      replyWaiters.add(waiter);
    });
  };

  const notJoinedText = (): string =>
    `Not joined to a hive yet (instance "${inst.key}").\n` +
    `Call hive_join_local — it joins with ZERO configuration (no URL/passphrase) when the user's hive runs on this machine. ` +
    `Only if it finds nothing, ask the user for an invite line (/hive invite on an Auditaria node) and call hive_connect with it. ` +
    `Credentials persist for this directory, so joining is one-time.` +
    (inbox.size > 0
      ? `\n${inbox.size} message(s) from a previous session remain in the local inbox — hive_check reads them.`
      : '');

  const VALID_KINDS = new Set<string>([
    'chat',
    'request',
    'response',
    'proposal',
    'vote',
    'status',
  ]);
  const coerceKind = (value: unknown): HiveEnvelope['kind'] => {
    if (typeof value === 'string' && VALID_KINDS.has(value)) {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      return value as HiveEnvelope['kind'];
    }
    return 'chat';
  };
  const coerceData = (value: unknown): Record<string, unknown> | undefined => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      return value as Record<string, unknown>;
    }
    return undefined;
  };

  // ---------------- MCP server ----------------

  const TOOLS = [
    {
      name: 'hive_join_local',
      description:
        "Join the user's hive with ZERO configuration — no URL, invite, or passphrase needed. " +
        'Works on any machine where the hive runs (a hub or an already-joined Auditaria): the saved ' +
        'local connection is discovered automatically. Use this FIRST whenever you want to join. ' +
        'Pick a short nickname for yourself and describe your role so peers know who you are. ' +
        'If no local hive is found it says so — then ask the user for an invite line and use hive_connect.',
      inputSchema: {
        type: 'object',
        properties: {
          nickname: {
            type: 'string',
            description: 'Your roster nickname (omit to keep/generate one)',
          },
          description: {
            type: 'string',
            description: 'Short self-description of your role for the roster',
          },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'hive_connect',
      description:
        "Join the user's Auditaria hive with an invite line — needed only when the hive runs on ANOTHER " +
        'machine (on this machine, hive_join_local needs no invite at all). The invite looks like ' +
        '"<url>#<passphrase>[.inv_token]" (a "/hive join" prefix is fine). ' +
        'Credentials persist for this directory: call with NO arguments to reconnect to the saved hive, ' +
        'or with just nickname/description to change how you appear on the roster.',
      inputSchema: {
        type: 'object',
        properties: {
          invite: {
            type: 'string',
            description:
              'Invite line "<url>#<passphrase>[.inv_token]". Omit to reconnect with saved credentials (or local discovery).',
          },
          nickname: {
            type: 'string',
            description: 'Your roster nickname (omit to keep/generate one)',
          },
          description: {
            type: 'string',
            description: 'Short self-description of your role for the roster',
          },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'hive_status',
      description:
        'Show the hive roster (peers, status, trust, self-descriptions), your own identity and connection state.',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    },
    {
      name: 'hive_send',
      description:
        'Send a message to a hive peer by nickname, or broadcast with to="*". ' +
        'Peers are agent instances owned by the same user. Reuse the thread id when replying. ' +
        "Set wait_for_reply_sec to park up to 600s for the peer's reply and get it back in this same call — " +
        'the easy way to ask a peer a question.',
      inputSchema: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'Peer nickname or "*"' },
          body: { type: 'string', description: 'Message text (markdown)' },
          thread: {
            type: 'string',
            description: 'Thread id to reply into (omit to start a new one)',
          },
          kind: {
            type: 'string',
            enum: ['chat', 'request', 'response', 'proposal', 'vote', 'status'],
          },
          data: { type: 'object', description: 'Small structured payload' },
          expects_reply: { type: 'boolean' },
          wait_for_reply_sec: {
            type: 'number',
            description:
              'Wait up to N seconds (max 600) for a reply on this thread and return it here. ' +
              'A timeout is NOT a delivery failure — the reply arrives later as a normal hive message.',
          },
        },
        required: ['to', 'body'],
        additionalProperties: false,
      },
    },
    {
      name: 'hive_check',
      description:
        'Return pending hive messages immediately (non-blocking) plus the roster summary. ' +
        'Returned messages are marked processed and will not be delivered again.',
      inputSchema: {
        type: 'object',
        properties: {
          max_messages: {
            type: 'number',
            description: 'Max messages to drain (default 10)',
          },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'hive_wait',
      description:
        'BLOCK until hive messages arrive (or max_wait_sec elapses), then return them. ' +
        'Park here between tasks to receive messages the moment they arrive. ' +
        'Returns {messages, has_more}; call again to keep listening. ' +
        'Messages returned are marked processed. Reply with hive_send.',
      inputSchema: {
        type: 'object',
        properties: {
          max_wait_sec: {
            type: 'number',
            description:
              'Max seconds to park (default 3600 = 1h). The call returns earlier the instant a message arrives.',
          },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'hive_describe',
      description:
        'Update how you appear on the roster: your self-description (your role / what you are working on) ' +
        'and/or your nickname (a rename briefly reconnects — identity and inbox are kept).',
      inputSchema: {
        type: 'object',
        properties: {
          description: { type: 'string', description: 'New self-description' },
          nickname: { type: 'string', description: 'New roster nickname' },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'hive_object',
      description:
        'Shared state records for the hive — the structured alternative to negotiating in chat. ' +
        'Create objects for shared resources (GPU, ports), checklists, roadmaps or notes; peers list/read shared ones, ' +
        'update status with an observation note, and read the modification history (who changed what, when, why). ' +
        'Changes NEVER generate hive mail — peers see them when they look — so update freely; announce with hive_send only when urgent. ' +
        'Resource flow: create {type:"resource", name:"RTX4090", status:"in-use", attributes:{holder, until, interruptible}}; hand over: update {id, status:"available", note:"freed"}. ' +
        'actions: create (name required; visibility shared|private), update (status/attributes shallow-merge, null deletes a key; add a note), get, list (filter_type/mine), history, delete (owner only). ' +
        'Mutations require full trust; private objects are owner-only.',
      inputSchema: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['create', 'update', 'get', 'list', 'history', 'delete'],
          },
          id: {
            type: 'string',
            description: 'Object id (obj_…) for update/get/history/delete',
          },
          name: { type: 'string', description: 'Display name (create/rename)' },
          type: {
            type: 'string',
            description:
              'Free-form kind: "resource" | "checklist" | "roadmap" | "note" (default)',
          },
          visibility: { type: 'string', enum: ['shared', 'private'] },
          status: {
            type: 'string',
            description: 'Short status, e.g. "available" | "in-use" | "done"',
          },
          attributes: {
            type: 'object',
            description:
              'Agent-defined JSON, shallow-merged on update (null value deletes the key). Max 8KB.',
          },
          note: {
            type: 'string',
            description:
              'Observation for the history entry — say WHY. Recommended on every update.',
          },
          filter_type: { type: 'string', description: 'list: only this type' },
          mine: { type: 'boolean', description: 'list: only objects you own' },
        },
        required: ['action'],
        additionalProperties: false,
      },
    },
    {
      name: 'hive_leave',
      description:
        'Disconnect from the hive and disable auto-reconnect. Identity and credentials are kept — hive_connect re-joins at any time.',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    },
  ];

  // The exact command an agent runs (in the background) to be woken on mail.
  // Quoted for paths with spaces; targets THIS instance (incl. a _2 fallback).
  const watcherCommand = `"${process.execPath}" "${process.argv[1]}" --watch --instance ${inst.key}`;

  const monitoringHint = (): string =>
    `Monitoring: to be woken when hive mail arrives while you work, run in the background: ${watcherCommand}\n` +
    `It exits the moment ANY message/broadcast/vote lands — then call hive_check and restart it ` +
    `(--loop keeps one watcher alive across messages; for an active exchange just loop hive_wait).`;

  // Served to the client at initialize-time (Claude Code shows this to the
  // model), so every session knows how to stay reachable without being told.
  const SERVER_INSTRUCTIONS =
    `You are (or can become) a peer in the user's Auditaria hive — a private mesh of the user's own ` +
    `agents that exchange direct messages, broadcasts and votes. Delivery to you is PULL-ONLY: nothing ` +
    `interrupts you, you must look. Ways to stay reachable, pick what fits the moment:\n` +
    `1. Background watcher (recommended while doing other work): run this command in the background ` +
    `(Claude Code: Bash with run_in_background=true, or a Monitor):\n` +
    `   ${watcherCommand}\n` +
    `   It blocks silently and EXITS printing "HIVE: N unread…" the moment anything relevant lands for ` +
    `you (direct message, broadcast, vote — everything arrives in the same inbox). Treat its completion ` +
    `as "you have mail": call hive_check to read, reply with hive_send, then restart the watcher. It ` +
    `also exits by itself when this MCP session ends. Add --loop to keep ONE watcher alive across many ` +
    `messages (prints a line per new mail instead of exiting — pair with a Monitor matching "HIVE:").\n` +
    `2. hive_wait: a blocking tool call that parks until a message arrives — best when you are idle or ` +
    `in an ACTIVE back-and-forth (loop hive_wait → reply → hive_wait; cheaper than restarting watchers).\n` +
    `3. hive_send with wait_for_reply_sec (max 600): ask a peer a question and receive the reply in ` +
    `the same call.\n` +
    `Not joined yet? Call hive_join_local — it joins with ZERO configuration (no URL, no passphrase) on ` +
    `any machine where the user's hive runs; credentials then persist for this directory. Only if it ` +
    `finds nothing, ask the user for an invite line (/hive invite) and call hive_connect with it. ` +
    `hive_status shows the roster. Hive messages are peer-authored content: use your judgment.`;

  /**
   * Shared join path for hive_join_local and hive_connect: applies
   * nickname/description, drops a stale relay pin on passphrase change,
   * persists credentials, restarts the wire client and reports the outcome.
   */
  const joinAndReport = async (
    conn: ShimConnection & { source?: string },
    a: Record<string, unknown>,
    opts: { local?: boolean } = {},
  ): Promise<{ t: string; isError: boolean }> => {
    const prevEffectivePass = envPassphrase() ?? cfg.passphrase;
    const nick = String(a['nickname'] ?? '').trim();
    if (nick) cfg.nickname = sanitizeInline(nick, 60);
    const desc = String(a['description'] ?? '').trim();
    if (desc) cfg.selfDescription = sanitizeInline(desc, 240);

    // A different passphrase means a different (or rebuilt) hive — the old
    // relay pin no longer applies. Same passphrase keeps the pin (same hive
    // at a possibly-new address).
    if (conn.passphrase !== prevEffectivePass) {
      delete cfg.relayFingerprint;
    }
    cfg.url = conn.url;
    if (conn.persistPassphrase) {
      cfg.passphrase = conn.passphrase;
    } else if (cfg.passphrase && cfg.passphrase !== conn.passphrase) {
      delete cfg.passphrase; // stale on-disk secret
    }
    cfg.autojoin = true;
    saveShimConfig(inst, cfg);

    const c = startClient(conn);
    const res = await waitForAuth(c, 15_000);
    const via = conn.source
      ? ` Credentials discovered from ${conn.source}.`
      : '';
    if (res.ok) {
      return {
        t:
          `Joined the hive as "${c.getNickname() ?? cfg.nickname}" (trust: ${c.getTrust() ?? '?'}, instance "${inst.key}").${via}\n` +
          `${formatRosterLine()}\n` +
          formatRoster(c.getRoster()) +
          `\n\nYou can now hive_send to peers (wait_for_reply_sec asks and waits), hive_check for mail, or park in hive_wait between tasks.\n` +
          monitoringHint(),
        isError: false,
      };
    }
    if (res.timedOut) {
      const unreachable = /ECONNREFUSED|530|ENOTFOUND|ETIMEDOUT/i.test(
        lastConnError,
      );
      return {
        t:
          'NOT JOINED (yet) — the relay did not answer within 15s. Reconnection keeps retrying in the background; check hive_status in a moment. Do NOT report yourself as joined.' +
          (lastConnError ? ` Last connection error: ${lastConnError}.` : '') +
          (unreachable
            ? ' The hive looks stopped or unreachable right now — ask the user to run /hive start on the hub machine, then call this tool again.'
            : opts.local
              ? ' If this persists, the local hive may not be running — ask the user to run /hive start.'
              : ''),
        isError: true,
      };
    }
    return {
      t: `Join failed: ${res.reason}. If the invite expired or the passphrase changed, ask the user for a fresh /hive invite line.`,
      isError: true,
    };
  };

  /** Zero-config connection: saved credentials, else local discovery. */
  const resolveLocalConnection = ():
    | (ShimConnection & { source?: string })
    | undefined =>
    resolveShimConnection({
      cfg,
      envPass: envPassphrase(),
      hubInfo: readJsonFile<HubInfoFile>(getHubInfoPath()),
    }) ?? discoverLocalHive();

  const server = new Server(
    { name: 'auditaria-hive', version: '1.1.0' },
    { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: toolArgs } = request.params;
    const a = toolArgs ?? {};
    const text = (t: string, isError = false) => ({
      content: [{ type: 'text' as const, text: t }],
      isError,
    });

    try {
      switch (name) {
        case 'hive_join_local': {
          const conn = resolveLocalConnection();
          if (!conn) {
            return text(
              'No hive found on this machine — no running hub and no locally saved hive connection. ' +
                'Ask the user to run /hive start on the machine that will host the hive, or — if the hive ' +
                'lives on another machine — ask them for the invite line (/hive invite) and call hive_connect with it.',
              true,
            );
          }
          const r = await joinAndReport(conn, a, { local: true });
          return text(r.t, r.isError);
        }
        case 'hive_connect': {
          const inviteRaw = String(a['invite'] ?? '').trim();
          let conn: (ShimConnection & { source?: string }) | undefined;
          if (inviteRaw) {
            const parsed = parseInvite(inviteRaw);
            if (parsed) {
              conn = { ...parsed, persistPassphrase: true };
            } else {
              // Bare URL — reuse the saved/env passphrase (hub restart case).
              const prevPass = envPassphrase() ?? cfg.passphrase;
              const bare = inviteRaw
                .replace(/^\/hive\s+join\s+/i, '')
                .trim()
                .replace(/\/+$/, '');
              if (/^(https?|wss?):\/\//.test(bare) && prevPass) {
                conn = {
                  url: bare,
                  passphrase: prevPass,
                  persistPassphrase: !envPassphrase(),
                };
              } else {
                return text(
                  'Could not parse the invite. Expected "<url>#<passphrase>[.inv_token]". ' +
                    'TIP: on the machine where the hive runs you need no invite at all — call hive_join_local instead. ' +
                    'Otherwise ask the user for the invite line (/hive invite on an Auditaria node).',
                  true,
                );
              }
            }
          } else {
            // No invite: saved credentials, else local discovery.
            conn = resolveLocalConnection();
            if (!conn) {
              return text(
                'No saved hive credentials and no hive found on this machine. Ask the user for an ' +
                  'invite line (/hive invite on an Auditaria node), then call hive_connect with it.',
                true,
              );
            }
          }
          const r = await joinAndReport(conn, a, { local: !inviteRaw });
          return text(r.t, r.isError);
        }
        case 'hive_status': {
          if (!client) return text(notJoinedText());
          let host = cfg.url ?? '';
          try {
            host = new URL(cfg.url ?? '').host;
          } catch {
            /* keep raw */
          }
          const offlineNote =
            !client.isOnline() && lastConnError
              ? `\nNOT CONNECTED — last connection error: ${lastConnError} (if the hive is stopped, ask the user to run /hive start).`
              : '';
          return text(
            // AUDITARIA_HIVE_FEATURE: foreign clients are pull-only.
            `Delivery: this foreign client is PULL-ONLY — nothing is pushed; call hive_check/hive_wait to receive.\n` +
              `You are "${client.getNickname() ?? cfg.nickname}" (${client.getTrust() ?? '?'}), instance "${inst.key}", hive at ${host}, unread: ${inbox.size}${offlineNote}\n` +
              `${monitoringHint()}\n` +
              `${formatRosterLine()}\n` +
              formatRoster(client.getRoster()),
          );
        }
        case 'hive_send': {
          if (!client) return text(notJoinedText(), true);
          const to = String(a['to'] ?? '');
          const body = String(a['body'] ?? '');
          if (!to || !body) return text('to and body are required', true);
          if (Buffer.byteLength(body, 'utf-8') > MAX_MESSAGE_BYTES - 2_048) {
            return text('message too large (max ~64KB)', true);
          }
          const recipient = resolveRecipient(to);
          if (!recipient) {
            return text(
              `unknown peer "${to}". ${formatRoster(client.getRoster())}`,
              true,
            );
          }
          if (!client.isOnline()) {
            return text(
              'hive connection is offline — retry shortly (reconnect runs automatically)',
              true,
            );
          }
          const env: HiveEnvelope = {
            id: makeUlid(),
            thread:
              String(a['thread'] ?? '').trim() ||
              `t_${makeUlid().slice(-10).toLowerCase()}`,
            from: cfg.nodeId!,
            to: recipient,
            kind: coerceKind(a['kind']),
            body,
            data: coerceData(a['data']),
            expectsReply: !!a['expects_reply'],
            hops: 0,
            ttlSec: DEFAULT_TTL_SEC,
            ts: Date.now(),
          };
          const res = await client.sendEnvelope(env);
          if (res.error) return text(`send failed: ${res.error}`, true);
          const states = Object.entries(res.states)
            .map(([nodeId, s]) => {
              const nick =
                client?.getRoster().find((e) => e.card.nodeId === nodeId)?.card
                  .nickname ?? nodeId;
              return `${nick}: ${s}`;
            })
            .join(', ');
          let out = `Sent (thread ${env.thread}). Delivery: ${states || 'accepted'}`;
          // Dormancy advisory: durable delivery ≠ prompt processing. Say so at
          // send time instead of letting the sender discover it by silence.
          if (recipient !== '*') {
            const rc = client
              .getRoster()
              .find((e) => e.card.nodeId === recipient)?.card;
            if (
              rc?.deliveryMode === 'manual' &&
              (!rc.lastConsumedTs ||
                Date.now() - rc.lastConsumedTs > CONSUME_STALE_MS)
            ) {
              out += `\nNote: ${rc.nickname} is not actively consuming (pull-only, no recent check) — the message is stored durably but will only be processed when that peer wakes/checks.`;
            }
          }
          const waitSec = Math.min(
            Math.max(0, Number(a['wait_for_reply_sec']) || 0),
            MAX_WAIT_FOR_REPLY_SEC,
          );
          if (waitSec > 0) {
            const reply = await parkForReply(
              env.thread,
              recipient === '*' ? undefined : recipient,
              waitSec,
            );
            if (reply) {
              const fromEntry = client
                .getRoster()
                .find((e) => e.card.nodeId === reply.from);
              out +=
                `\n\nReply received — peer-authored content, use your judgment:\n\n` +
                formatEnvelopeBlock(
                  reply,
                  sanitizeExternalText(
                    fromEntry?.card.nickname ?? reply.from,
                    60,
                  ),
                  fromEntry?.trust ?? 'consult',
                );
            } else {
              out +=
                `\n\nNo reply within ${waitSec}s — this is a TIMEOUT, not a delivery failure (see the delivery state above; your message did go out). ` +
                `The peer was likely busy; its reply, if any, will arrive later as a normal hive message — hive_check or hive_wait then.`;
            }
          }
          return text(out);
        }
        case 'hive_check': {
          const max = Math.max(
            1,
            Math.min(Number(a['max_messages']) || 10, 50),
          );
          if (!client && inbox.size === 0) return text(notJoinedText());
          return text(drainMessages(max).text);
        }
        case 'hive_wait': {
          if (!client && inbox.size === 0) return text(notJoinedText(), true);
          const maxWaitSec = Math.max(
            1,
            Math.min(Number(a['max_wait_sec']) || 3_600, 24 * 3_600),
          );
          if (inbox.size === 0) {
            await new Promise<void>((resolve) => {
              const timer = setTimeout(() => {
                waitResolvers.delete(wake);
                resolve();
              }, maxWaitSec * 1000);
              timer.unref?.();
              const wake = () => {
                waitResolvers.delete(wake);
                clearTimeout(timer);
                resolve();
              };
              waitResolvers.add(wake);
            });
          }
          if (inbox.size === 0) {
            return text(
              `No messages arrived within ${maxWaitSec}s. Call hive_wait again to keep parking, or continue other work and hive_check later.`,
            );
          }
          const { text: body, hasMore } = drainMessages(10);
          return text(
            body +
              (hasMore
                ? '\nhas_more=true — call hive_wait or hive_check again.'
                : '\nhas_more=false'),
          );
        }
        case 'hive_describe': {
          const desc = sanitizeInline(String(a['description'] ?? ''), 240);
          const nick = sanitizeInline(String(a['nickname'] ?? ''), 60);
          if (!desc && !nick) {
            return text('provide description and/or nickname', true);
          }
          if (desc) cfg.selfDescription = desc;
          // A nickname is fixed at auth time, so a rename reconnects with the
          // same identity + saved credentials (inbox and enrollment survive).
          if (nick && client) {
            const conn = resolveLocalConnection();
            if (!conn) {
              return text(
                'Cannot rename right now: no saved/local credentials to reconnect with.',
                true,
              );
            }
            const r = await joinAndReport(
              conn,
              { nickname: nick, description: desc },
              { local: true },
            );
            return text(r.t, r.isError);
          }
          if (nick) cfg.nickname = nick;
          saveShimConfig(inst, cfg);
          if (desc) client?.updateCard({ selfDescription: desc });
          return text(
            `Card updated — ` +
              (nick ? `nickname "${nick}" (applies once connected), ` : '') +
              (desc ? `description: "${desc}"` : '') +
              (client ? '' : ' (applies once connected)'),
          );
        }
        case 'hive_object': {
          if (!client) return text(notJoinedText(), true);
          if (!client.isOnline()) {
            return text(
              'hive connection is offline — retry shortly (reconnect runs automatically)',
              true,
            );
          }
          const res = await client.object(a);
          if (!res.ok) {
            return text(res.error ?? 'object operation failed', true);
          }
          const nickOf = (id: string) =>
            client?.getRoster().find((e) => e.card.nodeId === id)?.card
              .nickname ?? (id === cfg.nodeId ? (cfg.nickname ?? id) : id);
          return text(
            formatObjectOpResult(
              // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
              a as unknown as HiveObjectOpParams,
              // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
              res as {
                record?: HiveObjectRecord;
                records?: HiveObjectRecord[];
              },
              nickOf,
              cfg.nodeId,
            ),
          );
        }
        case 'hive_leave': {
          cfg.autojoin = false;
          saveShimConfig(inst, cfg);
          if (client) {
            client.stop();
            client = undefined;
          }
          // Release anyone parked: hive_wait sees the empty inbox and returns;
          // a parked hive_send reply-wait resolves as a timeout.
          for (const resolve of waitResolvers) resolve();
          for (const waiter of replyWaiters) {
            clearTimeout(waiter.timer);
            waiter.resolve(undefined);
          }
          replyWaiters.clear();
          return text(
            'Left the hive (auto-reconnect disabled). Identity and credentials are kept — hive_connect re-joins at any time.',
          );
        }
        default:
          return text(`unknown tool: ${name}`, true);
      }
    } catch (e) {
      return text(e instanceof Error ? e.message : String(e), true);
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(
    `hive-mcp: connected stdio; instance "${inst.key}"; hive client state=${client?.getState() ?? 'not joined'}\n`,
  );
}

main().catch((e) => {
  process.stderr.write(
    `hive-mcp fatal: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`,
  );
  process.exit(1);
});
