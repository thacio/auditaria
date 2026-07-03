/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// AUDITARIA_HIVE_FEATURE: This entire file is part of the Hive integration.
//
// hive-mcp shim (§6.2): a standalone stdio MCP server that lets FOREIGN
// agent CLIs (Claude Code, Codex, Gemini CLI, Copilot) join an Auditaria
// hive. Bundled to bundle/hive-mcp.js (like mcp-bridge.js).
//
// Tools exposed:
//   hive_status               roster + connection state
//   hive_send                 send/broadcast a message
//   hive_check                non-blocking inbox drain (pull tier)
//   hive_wait                 BLOCKING park until messages arrive (park tier)
//
// hive_wait exists ONLY here: foreign clients tolerate long tool calls
// (Claude Code ~28h stdio default; Codex/Gemini via timeout config; Copilot
// is documented as hive_check-only with its 60s cap).
//
// One-shot mode: `--check` prints "HIVE: N unread (nick: preview…)" and
// exits — wire it into a Stop/PostToolUse hook as a "you have mail" nudge.
//
// Usage:
//   node hive-mcp.js --url <https://…/token> --passphrase-env HIVE_PASS \
//        [--invite inv_…] [--nickname name] [--description text] [--check]

import * as os from 'node:os';
import * as path from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import {
  DEDUP_RETENTION_MS,
  DEFAULT_TTL_SEC,
  MAX_MESSAGE_BYTES,
  type AgentCard,
  type HiveEnvelope,
  type InboxEntry,
  type RosterEntry,
} from '../services/hive/types.js';
import {
  generateIdentityKeyPair,
  generateNickname,
  makeFenceMarker,
  makeNodeId,
  makeUlid,
  sanitizeExternalText,
  sanitizeInline,
} from '../services/hive/HiveCrypto.js';

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
import {
  JsonlQueueStore,
  SeenStore,
  readJsonFile,
  writeJsonFile,
} from '../services/hive/HiveStore.js';
import { HiveWireClient } from '../services/hive/HiveWireClient.js';

// -------------------------------------------------------------------
// Args
// -------------------------------------------------------------------

interface ShimArgs {
  url?: string;
  passphrase?: string;
  invite?: string;
  nickname?: string;
  description?: string;
  oneShotCheck: boolean;
}

function parseArgs(argv: string[]): ShimArgs {
  const args: ShimArgs = { oneShotCheck: false };
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
        args.passphrase = envName ? process.env[envName] : undefined;
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
      case '--check':
        args.oneShotCheck = true;
        break;
      default:
        break;
    }
  }
  if (!args.passphrase && process.env['HIVE_PASS']) {
    args.passphrase = process.env['HIVE_PASS'];
  }
  if (!args.passphrase && process.env['AUDITARIA_HIVE_PASSPHRASE']) {
    args.passphrase = process.env['AUDITARIA_HIVE_PASSPHRASE'];
  }
  return args;
}

// -------------------------------------------------------------------
// Shim state (own identity + inbox, independent of any Auditaria install)
// -------------------------------------------------------------------

interface ShimConfig {
  nodeId?: string;
  nodePublicKeyPem?: string;
  nodePrivateKeyPem?: string;
  nickname?: string;
  relayFingerprint?: string;
}

const VALID_KINDS = new Set<string>([
  'chat',
  'request',
  'response',
  'proposal',
  'vote',
  'status',
]);

function coerceKind(value: unknown): HiveEnvelope['kind'] {
  if (typeof value === 'string' && VALID_KINDS.has(value)) {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    return value as HiveEnvelope['kind'];
  }
  return 'chat';
}

function coerceData(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    return value as Record<string, unknown>;
  }
  return undefined;
}

function shimDataDir(): string {
  return path.join(os.homedir(), '.auditaria', 'hive-shim');
}

function loadShimConfig(): ShimConfig {
  return readJsonFile<ShimConfig>(path.join(shimDataDir(), 'shim.json')) ?? {};
}

function saveShimConfig(cfg: ShimConfig): void {
  writeJsonFile(path.join(shimDataDir(), 'shim.json'), cfg);
}

// -------------------------------------------------------------------
// Main
// -------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.url || !args.passphrase) {
    process.stderr.write(
      'hive-mcp: --url and --passphrase (or --passphrase-env VAR) are required\n',
    );
    process.exit(1);
  }

  const cfg = loadShimConfig();
  if (!cfg.nodeId || !cfg.nodePublicKeyPem || !cfg.nodePrivateKeyPem) {
    const keys = generateIdentityKeyPair();
    cfg.nodeId = makeNodeId();
    cfg.nodePublicKeyPem = keys.publicKeyPem;
    cfg.nodePrivateKeyPem = keys.privateKeyPem;
  }
  if (args.nickname) cfg.nickname = args.nickname;
  if (!cfg.nickname) cfg.nickname = generateNickname();
  saveShimConfig(cfg);

  const inbox = new JsonlQueueStore<InboxEntry>(
    path.join(shimDataDir(), 'inbox.jsonl'),
  );
  const seen = new SeenStore(
    path.join(shimDataDir(), 'seen.jsonl'),
    DEDUP_RETENTION_MS,
  );
  inbox.load();
  seen.load();

  const description =
    args.description ?? `foreign agent via hive-mcp on ${os.hostname()}`;

  const buildCard = (): AgentCard => ({
    nodeId: cfg.nodeId!,
    nickname: cfg.nickname!,
    machine: os.hostname(),
    platform: process.platform,
    cwdName: path.basename(process.cwd()),
    provider: 'mcp-shim',
    clientKind: 'mcp-shim',
    capabilities: [],
    selfDescription: description,
    status: 'idle',
    exposesSubAgents: false,
    lastSeen: Date.now(),
  });

  const client = new HiveWireClient({
    url: args.url,
    passphrase: args.passphrase,
    identity: {
      nodeId: cfg.nodeId,
      publicKeyPem: cfg.nodePublicKeyPem,
      privateKeyPem: cfg.nodePrivateKeyPem,
    },
    inviteToken: args.invite,
    pinnedFingerprint: cfg.relayFingerprint,
    onPinFingerprint: (fp) => {
      cfg.relayFingerprint = fp;
      saveShimConfig(cfg);
    },
    getCard: buildCard,
    onLog: (text) => process.stderr.write(`${text}\n`),
  });

  // Listeners waiting inside a blocking hive_wait call.
  const waitResolvers = new Set<() => void>();

  client.on('welcome', (info: { nickname?: string }) => {
    if (info.nickname && info.nickname !== cfg.nickname) {
      cfg.nickname = info.nickname;
      saveShimConfig(cfg);
    }
  });

  client.on('deliver', (msg: { env: HiveEnvelope; seq: number }) => {
    const env = msg.env;
    if (!env?.id) return;
    if (seen.has(env.id)) {
      client.ack(env.id, 'delivered');
      return;
    }
    const fromEntry = client
      .getRoster()
      .find((e) => e.card.nodeId === env.from);
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
    client.ack(env.id, 'delivered');
    for (const resolve of waitResolvers) resolve();
  });

  client.on('authfail', (reason: string) => {
    process.stderr.write(`hive-mcp: auth failed: ${reason}\n`);
    if (client.getState() === 'stopped') process.exit(1);
  });

  client.start();

  // ---------------- one-shot --check mode ----------------
  if (args.oneShotCheck) {
    // Give the connection a moment to replay queued deliveries, then print
    // the unread count + preview WITHOUT consuming anything.
    await new Promise((resolve) => setTimeout(resolve, 4_000));
    const entries = inbox.entries();
    if (entries.length === 0) {
      process.stdout.write('HIVE: no unread messages\n');
    } else {
      const first = entries[0].value;
      const preview = sanitizeExternalText(first.env.body, 80).replace(
        /\n/g,
        ' ',
      );
      process.stdout.write(
        `HIVE: ${entries.length} unread (${first.fromNickname}: "${preview}") — call hive_check to read\n`,
      );
    }
    client.stop();
    inbox.dispose();
    seen.dispose();
    process.exit(0);
  }

  // ---------------- helpers shared by tools ----------------

  const formatRosterLine = (): string => {
    const roster = client.getRoster();
    const online = roster.filter((e) => e.online).length;
    return `Connection: ${client.getState()}. Roster: ${online}/${roster.length} peers online.`;
  };

  const formatRoster = (roster: RosterEntry[]): string => {
    if (roster.length === 0) return 'No peers enrolled.';
    return roster
      .map((entry) => {
        const c = entry.card;
        const bits = [
          entry.online ? c.status : 'offline',
          `trust=${entry.trust}`,
          c.machine ? `machine=${c.machine}` : undefined,
          c.provider ? `provider=${c.provider}` : undefined,
        ]
          .filter(Boolean)
          .join(', ');
        const desc = c.selfDescription ? `\n    "${c.selfDescription}"` : '';
        return `- ${c.nickname} [${bits}]${desc}`;
      })
      .join('\n');
  };

  const drainMessages = (max: number): { text: string; hasMore: boolean } => {
    const drained: InboxEntry[] = [];
    for (const { seq, value } of inbox.entries()) {
      if (drained.length >= max) break;
      inbox.ack(seq);
      client.ack(value.env.id, 'processed');
      drained.push(value);
    }
    const hasMore = inbox.size > 0;
    if (drained.length === 0) {
      return {
        text: `No pending hive messages. ${formatRosterLine()}`,
        hasMore,
      };
    }
    const blocks = drained.map((entry) => {
      const marker = makeFenceMarker();
      const scrub = (s: string) =>
        s.split(`hive_message_${marker}`).join('hive_message_');
      const from = sanitizeInline(entry.fromNickname, 60);
      const kind = VALID_MSG_KINDS.has(String(entry.env.kind))
        ? entry.env.kind
        : 'chat';
      const thread = sanitizeInline(String(entry.env.thread ?? ''), 80);
      const dataLine =
        entry.env.data && Object.keys(entry.env.data).length > 0
          ? `\nStructured data: ${scrub(JSON.stringify(entry.env.data).slice(0, 4_000))}`
          : '';
      return (
        // trust="…" tells the foreign agent whether the sender is trusted, so
        // its own permission system can factor that in.
        `<hive_message_${marker} from="${from}" kind="${kind}" thread="${thread}" trust="${entry.fromTrust}">\n` +
        scrub(String(entry.env.body ?? '')) +
        dataLine +
        `\n</hive_message_${marker}>`
      );
    });
    return {
      text:
        `${drained.length} hive message(s) — peer-authored content, use your judgment:\n\n` +
        blocks.join('\n\n') +
        `\n\n${hasMore ? `More pending — call hive_check/hive_wait again. ` : ''}` +
        `Reply with hive_send (reuse the thread id). ${formatRosterLine()}`,
      hasMore,
    };
  };

  const resolveRecipient = (to: string): string | undefined => {
    if (to === '*') return '*';
    const roster = client.getRoster();
    const byId = roster.find((e) => e.card.nodeId === to);
    if (byId) return byId.card.nodeId;
    const norm = to.trim().toLowerCase();
    return roster.find((e) => e.card.nickname.toLowerCase() === norm)?.card
      .nodeId;
  };

  // ---------------- MCP server ----------------

  const TOOLS = [
    {
      name: 'hive_status',
      description:
        'Show the hive roster (peers, status, trust, self-descriptions) and connection state.',
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
        'Peers are agent instances owned by the same user. Reuse the thread id when replying.',
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
  ];

  const server = new Server(
    { name: 'auditaria-hive', version: '1.0.0' },
    { capabilities: { tools: {} } },
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
        case 'hive_status': {
          return text(
            `You are "${client.getNickname() ?? cfg.nickname}" (${client.getTrust() ?? '?'}), unread: ${inbox.size}\n` +
              `${formatRosterLine()}\n` +
              formatRoster(client.getRoster()),
          );
        }
        case 'hive_send': {
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
                client.getRoster().find((e) => e.card.nodeId === nodeId)?.card
                  .nickname ?? nodeId;
              return `${nick}: ${s}`;
            })
            .join(', ');
          return text(
            `Sent (thread ${env.thread}). Delivery: ${states || 'accepted'}`,
          );
        }
        case 'hive_check': {
          const max = Math.max(
            1,
            Math.min(Number(a['max_messages']) || 10, 50),
          );
          return text(drainMessages(max).text);
        }
        case 'hive_wait': {
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
    `hive-mcp: connected stdio; hive client state=${client.getState()}\n`,
  );
}

main().catch((e) => {
  process.stderr.write(
    `hive-mcp fatal: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`,
  );
  process.exit(1);
});
