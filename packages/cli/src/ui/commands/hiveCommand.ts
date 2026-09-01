/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// AUDITARIA_HIVE_FEATURE: This entire file is part of the Hive integration.
//
// /hive — manage the Auditaria Hive (multi-machine agent messaging, §8.1):
//   start | join | invite | status | send | describe | mode | trust |
//   untrust | remove | deliver | leave | stop

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  type SlashCommand,
  type CommandContext,
  type SlashCommandActionReturn,
  CommandKind,
} from './types.js';
import type { Config } from '@google/gemini-cli-core';
import {
  loadHiveConfig,
  saveHiveConfig,
  effectivePassphrase,
  parseInvite,
  getActiveHiveService,
  setActiveHiveService,
  getHiveInstanceDir,
  HiveService,
} from '../../services/hive/HiveService.js';
import {
  getHiveHubDir,
  getHubInfoPath,
  checkPidLock,
  acquirePidLock,
  releasePidLock,
} from '../../services/hive/hivePaths.js';
import { hubInfoFallbackUrls } from '../../services/hive/hivePolicy.js';
import { pushHiveToCliDisplay } from '../../services/hive/HiveBridge.js';
import { readJsonFile, writeJsonFile } from '../../services/hive/HiveStore.js';
import type { HiveHubHandle } from '../../services/hive/HiveHub.js';
import type { TunnelHandle } from '../../services/hive/HiveTunnel.js';
import type { TrustLevel, HubInfoFile } from '../../services/hive/types.js';
import { HIVE_HUB_BASE_PORT } from '../../services/hive/types.js';
import { makeStrongPassphrase } from '../../services/hive/HiveCrypto.js';

// -------------------------------------------------------------------
// Module state + single-instance lock
// -------------------------------------------------------------------

let activeHub: HiveHubHandle | undefined;
let activeTunnel: TunnelHandle | undefined;
/** Base invite URL for the running hive (tunnel or joined). */
let activeBaseUrl: string | undefined;

// Two PID-file locks:
//  - INSTANCE lock (per instance key): prevents two processes sharing the same
//    hive identity + queue files. Different instances (different cwd, or
//    AUDITARIA_HIVE_INSTANCE) are independent — many peers per machine are fine.
//  - HUB lock (machine-wide): only one node hosts the relay at a time.
function getInstanceLockPath(): string {
  return path.join(getHiveInstanceDir(), 'instance.lock');
}

function getHubLockPath(): string {
  return path.join(os.homedir(), '.auditaria', 'hive', 'hub.lock');
}

// Lock primitives live in hivePaths.ts (shared with the hive-mcp shim).
const checkLock = (): number | undefined => checkPidLock(getInstanceLockPath());
const acquireFileLock = (): boolean => acquirePidLock(getInstanceLockPath());
function releaseFileLock(): void {
  releasePidLock(getInstanceLockPath());
}

function msg(
  messageType: 'info' | 'error',
  content: string,
): SlashCommandActionReturn {
  return { type: 'message', messageType, content };
}

function getConfig(context: CommandContext): Config | undefined {
  return context.services.agentContext?.config;
}

function composeInvite(baseUrl: string, passphrase: string, token?: string) {
  return `/hive join ${baseUrl}#${passphrase}${token ? `.${token}` : ''}`;
}

// -------------------------------------------------------------------
// Start / join internals (shared with autoconnect)
// -------------------------------------------------------------------

/**
 * Start the hub (relay + tunnel) WITHOUT joining as a peer. Hosting and
 * participating are separate acts: /hive start serves, /hive join enrolls —
 * the hub machine's session only becomes a peer when it explicitly joins.
 */
async function startHubOnly(
  onProgress?: (text: string) => void,
): Promise<{ inviteLine: string; baseUrl: string }> {
  const saved = loadHiveConfig();
  const passphrase = effectivePassphrase(saved) ?? makeStrongPassphrase();
  if (!process.env['AUDITARIA_HIVE_PASSPHRASE'] && !saved.passphrase) {
    saved.passphrase = passphrase;
  }

  const { startHiveHub } = await import('../../services/hive/HiveHub.js');
  const { startQuickTunnel } = await import(
    '../../services/hive/HiveTunnel.js'
  );

  onProgress?.('Starting hive hub…');
  const hub = await startHiveHub({
    passphrase,
    port: saved.hub?.port ?? HIVE_HUB_BASE_PORT,
    trustPolicy: saved.trustPolicy ?? 'open',
    onLog: (text) => onProgress?.(text),
  });
  activeHub = hub;

  onProgress?.('Opening Cloudflare quick tunnel (this can take ~10s)…');
  let baseUrl: string;
  try {
    const tunnel = await startQuickTunnel(hub.port);
    activeTunnel = tunnel;
    baseUrl = `${tunnel.url}/${hub.urlToken}`;
  } catch (e) {
    // Tunnel failed (cloudflared missing / port 7844 blocked): keep the hub
    // usable on the local network and surface the actionable error.
    activeTunnel = undefined;
    baseUrl = `http://127.0.0.1:${hub.port}/${hub.urlToken}`;
    onProgress?.(
      `Tunnel unavailable — hive reachable on this machine/LAN only.\n${e instanceof Error ? e.message : String(e)}`,
    );
  }
  activeBaseUrl = baseUrl;

  // Machine-local discovery file: peers on THIS machine read it to re-point
  // automatically when the quick-tunnel hostname rotates (hub restart).
  try {
    writeJsonFile(getHubInfoPath(), {
      url: baseUrl,
      loopbackUrl: `http://127.0.0.1:${hub.port}/${hub.urlToken}`,
      urlToken: hub.urlToken,
      port: hub.port,
      pid: process.pid,
      startedAt: Date.now(),
    } satisfies HubInfoFile);
  } catch {
    /* discovery is best-effort */
  }

  saved.url = baseUrl;
  saved.hub = { port: hub.port };
  // Explicit start re-enables autoconnect (bring the HUB back next launch).
  saved.autoconnect = true;
  // Hosting ≠ participating: an undefined joined flag would be grandfathered
  // as "joined" (pre-split configs), so pin it to false on a fresh hub-only
  // start. An earlier explicit join stays respected.
  if (saved.joined === undefined) saved.joined = false;
  saveHiveConfig(saved);

  const inviteToken = hub.mintInvite('full');
  return {
    inviteLine: composeInvite(baseUrl, passphrase, inviteToken),
    baseUrl,
  };
}

/**
 * Prefer this machine's loopback address for a URL that points at the LOCAL
 * hub (token-matched via hub-info.json) — no tunnel hairpin, immune to
 * quick-tunnel rotation. Any other URL passes through unchanged.
 */
function preferLocalUrl(url: string): string {
  const candidates = hubInfoFallbackUrls(
    url,
    readJsonFile<HubInfoFile>(getHubInfoPath()),
  );
  return candidates[0] ?? url;
}

async function joinHive(
  config: Config,
  invite: { url: string; passphrase: string; inviteToken?: string },
  extras?: { nickname?: string; description?: string },
): Promise<HiveService> {
  const saved = loadHiveConfig();
  saved.url = invite.url;
  if (!process.env['AUDITARIA_HIVE_PASSPHRASE']) {
    saved.passphrase = invite.passphrase;
  }
  if (extras?.nickname) saved.nickname = extras.nickname;
  if (extras?.description) saved.selfDescription = extras.description;
  // Connecting (explicitly, or via autoconnect which only runs when already
  // enabled) means we want this hive back next launch.
  saved.autoconnect = true;
  saved.joined = true; // participation is explicit — set by join, not by start
  if (!activeHub) delete saved.hub; // hosting elsewhere → plain peer now
  saveHiveConfig(saved);

  const service = new HiveService(config, {
    url: invite.url,
    passphrase: invite.passphrase,
    inviteToken: invite.inviteToken,
    nickname: extras?.nickname,
    description: extras?.description,
  });
  service.start();
  setActiveHiveService(service);
  return service;
}

// -------------------------------------------------------------------
// Subcommand actions
// -------------------------------------------------------------------

// Guards the async background start against a double /hive start.
let hubStartInProgress = false;

async function startAction(
  _context: CommandContext,
): Promise<void | SlashCommandActionReturn> {
  if (activeHub) {
    return msg(
      'info',
      'This machine already hosts the hive hub. /hive status shows it; /hive join makes this session a peer.',
    );
  }
  if (hubStartInProgress) {
    return msg(
      'info',
      'A hive start is already in progress — watch for the invite line.',
    );
  }
  if (getActiveHiveService()) {
    return msg(
      'info',
      'This session is already joined to a hive. /hive leave first to host a new one here.',
    );
  }
  // Only one node hosts the relay per machine. No instance lock here:
  // hosting the hub does NOT make this session a peer (/hive join does).
  const hubHolder = checkPidLock(getHubLockPath());
  if (hubHolder && hubHolder !== process.pid) {
    return msg(
      'error',
      `A hive hub is already running on this machine (PID ${hubHolder}).\n` +
        `Join it as a peer with /hive join (no arguments needed on this machine).`,
    );
  }
  if (!acquirePidLock(getHubLockPath())) {
    return msg(
      'error',
      'Could not acquire the hub lock — another start is in progress.',
    );
  }
  hubStartInProgress = true;
  const progress = (text: string) =>
    pushHiveToCliDisplay({ type: 'info', text });
  // The tunnel takes ~10s (and can hang on locked-down networks) — never
  // block the UI on it. Progress + the invite line arrive as async info
  // lines; /hive status shows the state at any time.
  void (async () => {
    try {
      const { inviteLine } = await startHubOnly(progress);
      pushHiveToCliDisplay({
        type: 'info',
        text:
          `Hive hub is up. This session is NOT a peer yet — run /hive join (no arguments) if it should participate.\n\n` +
          `Invite (single-use token, full trust, 24h) — works from ANY machine:\n` +
          `  ${inviteLine}\n\n` +
          `Paste it in another Auditaria (/hive join …) or into an agent's chat.\n` +
          `Mint more with /hive invite (add --consult for a gated peer, --mcp for foreign CLI setup).`,
      });
    } catch (e) {
      // Tear the partially-started hub/tunnel down BEFORE freeing the lock,
      // so there's no window where the lock is free but the port is bound.
      await teardown();
      releasePidLock(getHubLockPath());
      pushHiveToCliDisplay({
        type: 'error',
        text: `Failed to start the hive: ${e instanceof Error ? e.message : String(e)}`,
      });
    } finally {
      hubStartInProgress = false;
    }
  })();
  return msg(
    'info',
    'Starting the hive hub in the background — the invite line will appear here when the tunnel is ready (~10s).\n' +
      'Note: /hive start only HOSTS the hub. Run /hive join afterwards if this session should also participate as a peer.',
  );
}

async function joinAction(
  context: CommandContext,
  args: string,
): Promise<void | SlashCommandActionReturn> {
  const config = getConfig(context);
  if (!config) return msg('error', 'Config not available yet.');
  const saved = loadHiveConfig();
  const savedPass = effectivePassphrase(saved);
  let invite = parseInvite(args);
  // No-argument form: join the saved/local hive — the natural follow-up to
  // /hive start on this machine (start hosts, join participates). Prefers
  // the loopback address when the URL points at this machine's own hub.
  if (!invite && !args.trim()) {
    if (saved.url && savedPass) {
      invite = { url: preferLocalUrl(saved.url), passphrase: savedPass };
    } else {
      return msg(
        'error',
        'No saved hive on this machine. Usage: /hive join <url>#<passphrase>[.<token>]\n' +
          '(On the hub machine, /hive start first — then a bare /hive join works.)',
      );
    }
  }
  // URL-only form: an enrolled peer can re-point at the hive's NEW address
  // (quick-tunnel hostnames rotate on every hub restart) with just
  // "/hive join <url>" — the saved passphrase is reused.
  if (!invite && savedPass) {
    const bare = args
      .trim()
      .replace(/^\/hive\s+join\s+/i, '')
      .replace(/\/+$/, '');
    if (/^https?:\/\/\S+$/i.test(bare) && !bare.includes('#')) {
      invite = { url: bare, passphrase: savedPass };
    }
  }
  if (!invite) {
    return msg(
      'error',
      'Could not parse the invite. Expected: /hive join <url>#<passphrase>[.<token>]' +
        (savedPass
          ? '\nAlready enrolled here — a bare "/hive join" (or with just the url) also works (reuses saved credentials).'
          : ''),
    );
  }
  const samePass = !!savedPass && invite.passphrase === savedPass;
  const active = getActiveHiveService();
  if (active) {
    if (activeHub) {
      return msg(
        'info',
        `Already hosting AND joined — peers join this hive at ${activeBaseUrl ?? '(unknown)'}. ` +
          'Use /hive invite to mint invites, or /hive leave first to join a different hive.',
      );
    }
    if (!samePass) {
      return msg(
        'info',
        'Already connected to a hive, and this invite carries a DIFFERENT passphrase (another hive). ' +
          'Use /hive leave first to switch hives.',
      );
    }
    // Same passphrase → same hive at a new address (hub restart rotated the
    // tunnel URL). Re-point in place: swap the connection but keep the
    // instance lock, identity, trust, queues AND the relay-fingerprint pin —
    // the pin then cryptographically verifies it IS the same hub.
    await active.stop().catch(() => {});
    setActiveHiveService(undefined);
    try {
      const service = await joinHive(config, invite);
      activeBaseUrl = invite.url;
      return msg(
        'info',
        `Hive address updated — reconnecting to ${invite.url} as "${service.getNickname()}" (identity and queues kept).`,
      );
    } catch (e) {
      await teardown();
      releaseFileLock();
      return msg(
        'error',
        `Failed to re-point: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  if (!acquireFileLock()) {
    return msg(
      'error',
      `Another Auditaria instance (PID ${checkLock()}) is already running the hive on this machine.`,
    );
  }
  try {
    // Pin handling: a DIFFERENT passphrase means a different (or rebuilt)
    // hive — clear any pin left from before so we TOFU the relay THIS invite
    // points to (the invite's passphrase is the primary auth; this is why
    // joining a reset/rebuilt hive doesn't fail with "relay key changed").
    // The SAME passphrase means the same hive at a possibly-new address —
    // KEEP the pin so the relay key is verified. Autoconnect reconnects
    // always verify the pin to catch a mid-session relay swap.
    if (!samePass) {
      const cfg = loadHiveConfig();
      if (cfg.relayFingerprint) {
        delete cfg.relayFingerprint;
        saveHiveConfig(cfg);
      }
    }
    const service = await joinHive(config, invite);
    activeBaseUrl = invite.url;
    return msg(
      'info',
      `Joining the hive at ${invite.url} — connection runs in the background.\n` +
        `You will appear as "${service.getNickname()}" once connected. Watch for the "hive: connected" line; /hive status shows the roster.`,
    );
  } catch (e) {
    // joinHive may have partially started a service (timers/WS/registered
    // transport) before throwing — tear it down before freeing the lock.
    await teardown();
    releaseFileLock();
    return msg(
      'error',
      `Failed to join: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

async function inviteAction(
  _context: CommandContext,
  args: string,
): Promise<void | SlashCommandActionReturn> {
  const service = getActiveHiveService();
  // Minting works joined OR hub-only (the hub mints directly).
  if (!service && !activeHub) {
    return msg(
      'error',
      'The hive is not running. /hive start or /hive join first.',
    );
  }
  const wantsConsult = /(^|\s)--consult(\s|$)/.test(args);
  const wantsMcp = /(^|\s)--mcp(\s|$)/.test(args);
  const trust: TrustLevel = wantsConsult || wantsMcp ? 'consult' : 'full';

  const saved = loadHiveConfig();
  const passphrase = effectivePassphrase(saved);
  const baseUrl = activeBaseUrl ?? saved.url;
  if (!passphrase || !baseUrl) {
    return msg('error', 'Hive credentials not available — re-join the hive.');
  }

  let token: string;
  if (activeHub) {
    token = activeHub.mintInvite(trust);
  } else if (!service) {
    return msg('error', 'The hive is not running.');
  } else {
    try {
      const res = await serviceAdmin(service, 'invite', { trust });
      token = String(res['token'] ?? '');
      if (!token)
        return msg('error', 'The relay did not return an invite token.');
    } catch (e) {
      return msg(
        'error',
        `Could not mint an invite: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  const inviteLine = composeInvite(baseUrl, passphrase, token);
  let content =
    `Invite (single-use, ${trust === 'full' ? 'full trust' : 'consult — state-changing tools gated'}, 24h):\n` +
    `  ${inviteLine}`;
  if (wantsMcp) {
    content +=
      `\n\nForeign CLI setup (hive-mcp shim — hive_connect / hive_send / hive_check / blocking hive_wait):\n` +
      `  1) Register once, NO arguments needed (works for every project after that):\n` +
      `       Claude Code:  claude mcp add --scope user hive -- node <auditaria>/bundle/hive-mcp.js\n` +
      `       Codex:        same command under [mcp_servers.hive] in config.toml, plus tool_timeout_sec = 86400\n` +
      `       Gemini CLI:   settings.json mcpServers entry with "timeout": 86400000\n` +
      `       Copilot CLI:  works with hive_check only (60s tool cap — no hive_wait parking)\n` +
      `  2) On THIS machine: just ask the agent to "join the hive" — it calls hive_join_local,\n` +
      `     which discovers the local hive automatically (no invite/passphrase to paste).\n` +
      `     On OTHER machines: paste the invite line above into the agent's chat (hive_connect).\n` +
      `     Credentials persist per project directory (each directory = its own hive peer;\n` +
      `     future sessions reconnect automatically).\n` +
      `  Note: an agent session already running when the MCP server is added must be RESTARTED\n` +
      `  to see the hive tools. Agents already bridged to an Auditaria node (auditaria-tools)\n` +
      `  speak AS that node — the shim is what gives them their own identity + inbox + watcher.\n` +
      `  One-shot hook nudge ("you have mail"): node <auditaria>/bundle/hive-mcp.js --check`;
  }
  return msg('info', content);
}

/** Run a hive-wide admin op through the active service. */
async function serviceAdmin(
  service: HiveService,
  op: 'trust' | 'untrust' | 'remove' | 'invite',
  fields: { nickname?: string; trust?: TrustLevel } = {},
): Promise<Record<string, unknown>> {
  return service.admin(op, fields);
}

async function statusAction(): Promise<void | SlashCommandActionReturn> {
  const service = getActiveHiveService();
  const saved = loadHiveConfig();
  if (!service && activeHub) {
    // Hub-only: hosting without participating.
    const roster = activeHub.listRoster();
    const online = roster.filter((e) => e.online).length;
    const pass = effectivePassphrase(saved);
    const peerLines =
      roster.length === 0
        ? '  (no peers enrolled yet)'
        : roster
            .map(
              (e) =>
                `  - ${e.card.nickname} [${e.online ? 'online' : 'offline'}, trust=${e.trust}, queued=${e.queued}]`,
            )
            .join('\n');
    return msg(
      'info',
      `Hub: running locally on port ${activeHub.port}${activeTunnel ? ` behind ${activeTunnel.url}` : ' (no tunnel — LAN only)'}\n` +
        `This session is NOT a peer (hub only) — /hive join to participate.\n` +
        (activeBaseUrl && pass
          ? `Current invite (re-share after a restart — the URL changes each time):\n  ${composeInvite(activeBaseUrl, pass)}\n`
          : '') +
        `Peers: ${online}/${roster.length} online\n${peerLines}`,
    );
  }
  if (!service) {
    let text = 'Hive: not running.';
    if (saved.url) {
      text += `\nSaved hive: ${saved.url} (autoconnect ${saved.autoconnect === false ? 'off' : 'on'})`;
      text += saved.hub
        ? '\nThis machine hosts the hub — /hive start brings it back (new tunnel URL; peers re-join with /hive invite).'
        : '\nRejoin with /hive join <invite> or restart Auditaria (autoconnect).';
    } else {
      text += '\nStart one with /hive start, or join with /hive join <invite>.';
    }
    return msg('info', text);
  }
  const roster = await service.status({});
  const hubLine = activeHub
    ? `Hub: running locally on port ${activeHub.port}${activeTunnel ? ` behind ${activeTunnel.url}` : ' (no tunnel — LAN only)'}\n`
    : '';
  // Surface a paste-ready invite when we host the hub — the tunnel URL changes
  // on every restart, so this is the easy way to (re)share the current address.
  let inviteLine = '';
  if (activeHub && activeBaseUrl) {
    const pass = effectivePassphrase(saved);
    if (pass) {
      inviteLine =
        `Current invite (re-share after a restart — the URL changes each time):\n` +
        `  ${composeInvite(activeBaseUrl, pass)}\n` +
        `  (a brand-new peer under an invite/manual policy needs a token: /hive invite)\n`;
    }
  }
  // AUDITARIA_HIVE_FEATURE: surface delivery posture + unread for the human.
  const deliveryMode = service.getDeliveryMode();
  const modeLine = `Mode: ${saved.mode ?? 'main'} | delivery: ${deliveryMode} (${service.getUnreadCount()} unread) | trust policy: ${saved.trustPolicy ?? 'open'}\n`;
  return msg('info', hubLine + inviteLine + modeLine + roster);
}

async function sendAction(
  _context: CommandContext,
  args: string,
): Promise<void | SlashCommandActionReturn> {
  const service = getActiveHiveService();
  if (!service) return msg('error', 'The hive is not running.');
  const trimmed = args.trim();
  const spaceIdx = trimmed.indexOf(' ');
  if (spaceIdx <= 0) {
    return msg('error', 'Usage: /hive send <nickname|*> <message>');
  }
  const to = trimmed.slice(0, spaceIdx);
  const body = trimmed.slice(spaceIdx + 1).trim();
  if (!body) return msg('error', 'Usage: /hive send <nickname|*> <message>');
  try {
    const result = await service.sendMessage({ to, body, kind: 'chat' });
    const states = Object.values(result.states);
    const summary =
      to === '*'
        ? `broadcast to ${states.length} peer(s)`
        : String(states[0] ?? 'sent');
    return msg(
      'info',
      `[Hive] you → ${to}: ${summary} (thread ${result.thread})`,
    );
  } catch (e) {
    return msg('error', e instanceof Error ? e.message : String(e));
  }
}

async function describeAction(
  _context: CommandContext,
  args: string,
): Promise<void | SlashCommandActionReturn> {
  const service = getActiveHiveService();
  if (!service) return msg('error', 'The hive is not running.');
  const desc = args.trim();
  if (!desc) {
    return msg(
      'error',
      'Usage: /hive describe <1–2 sentence self-description>',
    );
  }
  await service.status({ update_description: desc });
  return msg(
    'info',
    "Self-description updated (visible in every peer's roster).",
  );
}

async function modeAction(
  _context: CommandContext,
  args: string,
): Promise<void | SlashCommandActionReturn> {
  const value = args.trim();
  if (value !== 'main' && value !== 'approve') {
    const saved = loadHiveConfig();
    return msg(
      'info',
      `Current mode: ${saved.mode ?? 'main'}\n` +
        'Usage: /hive mode <main|approve>\n' +
        '  main    — hive messages are handed to the model at turn boundaries, hands-free\n' +
        '  approve — each inbound message waits for /hive deliver',
    );
  }
  const saved = loadHiveConfig();
  saved.mode = value;
  saveHiveConfig(saved);
  return msg('info', `Hive delivery mode set to "${value}".`);
}

// AUDITARIA_HIVE_FEATURE_START
async function deliveryAction(
  context: CommandContext,
  args: string,
): Promise<void | SlashCommandActionReturn> {
  const value = args.trim().toLowerCase();
  const service = getActiveHiveService();
  if (value !== 'auto' && value !== 'manual') {
    const current =
      service?.getDeliveryMode() ?? loadHiveConfig().delivery ?? 'auto';
    return msg(
      'info',
      `Current delivery: ${current}\n` +
        'Usage: /hive delivery <auto|manual>\n' +
        '  auto   — peer messages are auto-pushed to the model at turn boundaries (default)\n' +
        '  manual — messages wait in the inbox; the model/user pulls them with hive_check',
    );
  }
  if (!service) {
    const saved = loadHiveConfig();
    saved.delivery = value;
    saveHiveConfig(saved);
    return msg(
      'info',
      `Delivery mode saved as "${value}" (applies when the hive next starts).`,
    );
  }
  service.setDeliveryMode(value);
  const unread = service.getUnreadCount();
  // Human-facing confirmation (UI only).
  context.ui.addItem(
    {
      type: 'info',
      text: `[Hive] delivery set to ${value}${value === 'manual' && unread > 0 ? ` (${unread} unread waiting)` : ''}.`,
    },
    Date.now(),
  );
  // Push the instruction to the HEADLESS session AI as a real turn. The turn
  // is intentional (the AI must know the mode AND act on it: set up polling in
  // manual, tear it down in auto) — but its reply is constrained to one
  // sentence so the switch doesn't trigger an open-ended conversational
  // response ("what would you like to work on?").
  const aiInstruction =
    value === 'manual'
      ? `[Hive delivery mode changed by the user — not a task request.] Automatic hive push is now OFF — peer messages will NOT be delivered to you automatically. To receive them you must actively check: call hive_check to pull pending messages, or (foreign shim) hive_wait to park and monitor. If you are coordinating with peers right now, set up a monitoring pattern (e.g. a periodic hive_check).${unread > 0 ? ` ${unread} message(s) are already waiting — call hive_check now.` : ''} Then acknowledge in ONE short sentence stating the new mode and what (if anything) you set up. Do not ask the user anything.`
      : `[Hive delivery mode changed by the user — not a task request.] Automatic hive push is ON again — peer messages arrive automatically at the start of your next turn. If you previously set up a hive polling pattern (a cron/loop calling hive_check), tear it down now — it is no longer needed. Then acknowledge in ONE short sentence. Do not ask the user anything.`;
  return { type: 'submit_prompt', content: aiInstruction };
}
// AUDITARIA_HIVE_FEATURE_END

async function deliverAction(): Promise<void | SlashCommandActionReturn> {
  const service = getActiveHiveService();
  if (!service) return msg('error', 'The hive is not running.');
  const pending = service.getUnreadCount();
  if (pending === 0) return msg('info', 'No hive messages waiting.');
  service.approveDelivery(pending);
  return msg(
    'info',
    `Delivering ${pending} pending message(s) to the model at the next turn boundary.`,
  );
}

function makeTrustAction(op: 'trust' | 'untrust' | 'remove') {
  return async (
    _context: CommandContext,
    args: string,
  ): Promise<void | SlashCommandActionReturn> => {
    const service = getActiveHiveService();
    if (!service) return msg('error', 'The hive is not running.');
    const nickname = args.trim();
    if (!nickname) return msg('error', `Usage: /hive ${op} <nickname>`);
    try {
      await serviceAdmin(service, op, { nickname });
      const text =
        op === 'trust'
          ? `${nickname} is now trusted hive-wide (state-changing tools run hands-free for it).`
          : op === 'untrust'
            ? `${nickname} is now consult-level hive-wide (state-changing tools are declined).`
            : `${nickname}'s key is now blocked — it can't reconnect with that identity.\n` +
              `IMPORTANT: this does NOT revoke the passphrase. Under the default 'open' policy a machine that still holds the ` +
              `hive passphrase can re-enroll with a fresh key. To fully lock out a lost/compromised machine, rotate the ` +
              `passphrase (change AUDITARIA_HIVE_PASSPHRASE or ~/.auditaria/hive.json on the hub and re-invite your machines).`;
      return msg('info', text);
    } catch (e) {
      return msg('error', e instanceof Error ? e.message : String(e));
    }
  };
}

async function leaveAction(): Promise<void | SlashCommandActionReturn> {
  const service = getActiveHiveService();
  if (!service && !activeHub) return msg('info', 'The hive is not running.');
  await teardown();
  const saved = loadHiveConfig();
  saved.autoconnect = false;
  saved.joined = false;
  saveHiveConfig(saved);
  releaseFileLock();
  return msg(
    'info',
    'Left the hive (autoconnect disabled). Identity and queues are kept — /hive join or /hive start reconnects.',
  );
}

async function stopAction(): Promise<void | SlashCommandActionReturn> {
  if (!getActiveHiveService() && !activeHub) {
    return msg('info', 'The hive is not running.');
  }
  await teardown();
  releaseFileLock();
  return msg(
    'info',
    'Hive stopped. Queued messages are safe on disk; autoconnect will bring it back next launch (or /hive leave to disable).',
  );
}

/** Delete this instance's durable queue files (inbox/outbox/dlq/seen/processed). */
function purgeInstanceQueues(): void {
  const dir = getHiveInstanceDir();
  for (const f of [
    'inbox.jsonl',
    'outbox.jsonl',
    'dlq.jsonl',
    'seen.jsonl',
    'processed.jsonl',
  ]) {
    try {
      fs.rmSync(path.join(dir, f), { force: true });
    } catch {
      /* best-effort */
    }
  }
}

/**
 * Destroy the current hive and start clean. Two-step (destructive): a bare
 * "/hive reset" explains and requires "/hive reset confirm" to proceed.
 * Deletes the machine's hub state (new url token + relay key + passphrase on
 * the next /hive start = a genuinely NEW hive that old peers can't rejoin),
 * clears this instance's hive membership, and purges its queues. "--hard"
 * also regenerates this node's identity (new nodeId/nickname).
 */
async function resetAction(
  _context: CommandContext,
  args: string,
): Promise<void | SlashCommandActionReturn> {
  const arg = args.trim();
  const confirmed = /^confirm\b/.test(arg);
  const hard = /(^|\s)(--hard|hard)(\s|$)/.test(arg);
  if (!confirmed) {
    return msg(
      'info',
      'This DESTROYS the current hive and starts clean. It will:\n' +
        '  • stop the hive and delete this machine’s hub state (new URL token, relay key and passphrase next time)\n' +
        '  • forget this hive on this instance and purge its message queues (inbox/outbox/dead-letter)\n' +
        '  • old peers can NOT rejoin the new hive (new fingerprint) — they must be re-invited\n\n' +
        'To proceed: /hive reset confirm   (keeps this node’s identity/nickname)\n' +
        'Full wipe:  /hive reset confirm --hard   (also a new identity)\n' +
        'Then /hive start to create the brand-new hive.',
    );
  }
  // Stop everything and release both locks.
  await teardown();
  releasePidLock(getHubLockPath());
  releaseFileLock();
  // Delete the machine-wide hub state (identity of the hive lives here).
  try {
    fs.rmSync(getHiveHubDir(), { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
  // And the hub-info discovery file — its urlToken belongs to the dead hive.
  try {
    fs.rmSync(getHubInfoPath(), { force: true });
  } catch {
    /* best-effort */
  }
  // Forget this hive on this instance; purge its queues.
  const saved = loadHiveConfig();
  delete saved.url;
  delete saved.passphrase;
  delete saved.relayFingerprint;
  delete saved.hub;
  saved.autoconnect = false;
  saved.joined = false;
  if (hard) {
    delete saved.nodeId;
    delete saved.nodePublicKeyPem;
    delete saved.nodePrivateKeyPem;
    delete saved.nickname;
    delete saved.selfDescription;
  }
  saveHiveConfig(saved);
  purgeInstanceQueues();
  return msg(
    'info',
    `Hive reset${hard ? ' (hard — new identity)' : ''}. Everything from the old hive is gone.\n` +
      'Run /hive start for a brand-new hive, or /hive join <invite> to join a different one.',
  );
}

// AUDITARIA_HIVE_FEATURE: human view of the hive's shared objects.
async function objectsAction(): Promise<void | SlashCommandActionReturn> {
  const service = getActiveHiveService();
  if (!service) {
    return msg(
      'error',
      'Not joined to a hive — objects are read through your peer connection. /hive join first.',
    );
  }
  try {
    return msg('info', await service.object({ action: 'list' }));
  } catch (e) {
    return msg('error', e instanceof Error ? e.message : String(e));
  }
}

async function teardown(): Promise<void> {
  const service = getActiveHiveService();
  if (service) {
    await service.stop().catch(() => {});
    setActiveHiveService(undefined);
  }
  if (activeTunnel) {
    try {
      activeTunnel.stop();
    } catch {
      /* ignore */
    }
    activeTunnel = undefined;
  }
  if (activeHub) {
    await activeHub.close().catch(() => {});
    activeHub = undefined;
    // We hosted the relay — free the machine-wide hub lock so another node
    // can host next (no-op if we didn't hold it).
    releasePidLock(getHubLockPath());
  }
  activeBaseUrl = undefined;
}

async function defaultAction(
  _context: CommandContext,
  _args: string,
): Promise<void | SlashCommandActionReturn> {
  const running = !!getActiveHiveService();
  return msg(
    'info',
    'Auditaria Hive — hands-free messaging between your own agent instances\n\n' +
      'Usage:\n' +
      '  /hive start                     Host a hub on this machine (+ quick tunnel) — hub only, does NOT join\n' +
      '  /hive join [invite]             Join as a peer (no arguments = the saved/local hive)\n' +
      '  /hive invite [--consult] [--mcp]  Mint a single-use invite (default: full trust)\n' +
      '  /hive status                    Roster, queues, connection state\n' +
      '  /hive send <nick|*> <message>   Message a peer; * = hive-wide chat\n' +
      '  /hive objects                   List shared hive objects (resources, checklists, roadmaps)\n' +
      '  /hive describe <text>           Set your roster self-description\n' +
      '  /hive mode <main|approve>       Hands-free delivery vs per-message approval\n' +
      // AUDITARIA_HIVE_FEATURE
      '  /hive delivery <auto|manual>    Auto-push peer messages, or hold them for hive_check\n' +
      '  /hive deliver                   Hand pending messages to the model (approve mode)\n' +
      "  /hive trust|untrust <nick>      Change a peer's trust hive-wide\n" +
      '  /hive remove <nick>             Revoke a node (lost machine)\n' +
      '  /hive leave                     Disconnect and disable autoconnect\n' +
      '  /hive stop                      Stop (autoconnect stays on)\n' +
      '  /hive reset [confirm] [--hard]  Destroy this hive and start clean\n\n' +
      'The agent itself can join with the hive_connect tool (paste an invite in chat) and use hive_send / hive_status / hive_check.\n\n' +
      (running ? 'Hive is currently RUNNING.' : 'Hive is currently STOPPED.'),
  );
}

// -------------------------------------------------------------------
// Autoconnect + cleanup (wired in gemini.tsx)
// -------------------------------------------------------------------

/**
 * Reconnects the saved hive on launch (quiet best-effort, like Telegram
 * autostart). Hub machines restart the hub + tunnel; peers just reconnect.
 */
export async function autoConnectHive(config: Config): Promise<void> {
  if (getActiveHiveService()) return;
  const saved = loadHiveConfig();
  if (saved.autoconnect === false) return;
  const passphrase = effectivePassphrase(saved);
  if (!passphrase) return;
  // Hosting and participating are independent intents: `hub` says re-host
  // the relay; `joined` (grandfathered true when undefined, for configs
  // predating the start/join split) says re-enroll as a peer.
  const wantHub = !!saved.hub;
  const wantJoin = !!saved.url && saved.joined !== false;
  if (!wantHub && !wantJoin) return;
  const gotHubLock = wantHub && acquirePidLock(getHubLockPath());
  if (wantHub && !gotHubLock && !wantJoin) return; // hosted elsewhere already
  if (wantJoin && !acquireFileLock()) {
    if (gotHubLock) releasePidLock(getHubLockPath());
    return;
  }
  try {
    if (gotHubLock) {
      await startHubOnly();
    }
    if (wantJoin) {
      const url = preferLocalUrl(saved.url!);
      await joinHive(config, { url, passphrase });
      activeBaseUrl = saved.url;
    }
  } catch {
    // startHubOnly assigns activeHub/activeTunnel before fully up — tear the
    // partial state down (teardown frees the hub lock), then free the
    // instance lock. Otherwise an orphan keeps the port bound.
    await teardown();
    releasePidLock(getHubLockPath()); // in case we failed before activeHub was set
    releaseFileLock();
    // Silent — autoconnect is best-effort; /hive status explains state.
  }
}

/** Stops hive components if running. Called during app cleanup. */
export async function stopHiveIfRunning(): Promise<void> {
  await teardown();
  releaseFileLock();
}

// -------------------------------------------------------------------
// Command export
// -------------------------------------------------------------------

export const hiveCommand: SlashCommand = {
  name: 'hive',
  description: 'Manage the Auditaria Hive (multi-machine agent messaging)',
  kind: CommandKind.BUILT_IN,
  autoExecute: false,
  subCommands: [
    {
      name: 'start',
      description:
        'Host a hive hub on this machine (hub only — /hive join to participate)',
      kind: CommandKind.BUILT_IN,
      autoExecute: true,
      action: startAction,
    },
    {
      name: 'objects',
      description: 'List shared hive objects (resources, checklists, roadmaps)',
      kind: CommandKind.BUILT_IN,
      autoExecute: true,
      action: objectsAction,
    },
    {
      name: 'join',
      description:
        'Join as a peer. Usage: /hive join [<url>#<passphrase>[.<token>]] (no args = saved/local hive)',
      kind: CommandKind.BUILT_IN,
      autoExecute: false,
      action: joinAction,
    },
    {
      name: 'invite',
      description:
        'Mint a single-use invite. Usage: /hive invite [--consult] [--mcp]',
      kind: CommandKind.BUILT_IN,
      autoExecute: false,
      action: inviteAction,
    },
    {
      name: 'status',
      description: 'Show hive roster, queues and connection state',
      kind: CommandKind.BUILT_IN,
      autoExecute: true,
      action: statusAction,
    },
    {
      name: 'send',
      description: 'Send a message. Usage: /hive send <nickname|*> <message>',
      kind: CommandKind.BUILT_IN,
      autoExecute: false,
      action: sendAction,
    },
    {
      name: 'describe',
      description: 'Set your roster self-description',
      kind: CommandKind.BUILT_IN,
      autoExecute: false,
      action: describeAction,
    },
    {
      name: 'mode',
      description: 'Set delivery mode. Usage: /hive mode <main|approve>',
      kind: CommandKind.BUILT_IN,
      autoExecute: false,
      action: modeAction,
    },
    {
      name: 'deliver',
      description: 'Hand pending hive messages to the model (approve mode)',
      kind: CommandKind.BUILT_IN,
      autoExecute: true,
      action: deliverAction,
    },
    // AUDITARIA_HIVE_FEATURE
    {
      name: 'delivery',
      description: 'Auto-push vs pull. Usage: /hive delivery <auto|manual>',
      kind: CommandKind.BUILT_IN,
      autoExecute: false,
      action: deliveryAction,
    },
    {
      name: 'trust',
      description: 'Trust a peer hive-wide. Usage: /hive trust <nickname>',
      kind: CommandKind.BUILT_IN,
      autoExecute: false,
      action: makeTrustAction('trust'),
    },
    {
      name: 'untrust',
      description:
        'Set a peer to consult level. Usage: /hive untrust <nickname>',
      kind: CommandKind.BUILT_IN,
      autoExecute: false,
      action: makeTrustAction('untrust'),
    },
    {
      name: 'remove',
      description:
        'Revoke a node (lost machine). Usage: /hive remove <nickname>',
      kind: CommandKind.BUILT_IN,
      autoExecute: false,
      action: makeTrustAction('remove'),
    },
    {
      name: 'leave',
      description: 'Disconnect from the hive and disable autoconnect',
      kind: CommandKind.BUILT_IN,
      autoExecute: true,
      action: leaveAction,
    },
    {
      name: 'stop',
      description: 'Stop the hive (autoconnect stays enabled)',
      kind: CommandKind.BUILT_IN,
      autoExecute: true,
      action: stopAction,
    },
    {
      name: 'reset',
      description:
        'Destroy the current hive and start clean (/hive reset confirm)',
      kind: CommandKind.BUILT_IN,
      autoExecute: false,
      action: resetAction,
    },
  ],
  action: defaultAction,
};
