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
  hiveInstanceKey,
  HiveService,
} from '../../services/hive/HiveService.js';
import { getHiveHubDir } from '../../services/hive/hivePaths.js';
import type { HiveHubHandle } from '../../services/hive/HiveHub.js';
import type { TunnelHandle } from '../../services/hive/HiveTunnel.js';
import type { TrustLevel } from '../../services/hive/types.js';
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

/** PID held by a live process on this lock, or undefined (stale locks pruned). */
function checkLockAt(lockPath: string): number | undefined {
  try {
    if (!fs.existsSync(lockPath)) return undefined;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    const data = JSON.parse(fs.readFileSync(lockPath, 'utf-8')) as {
      pid: number;
    };
    if (!data.pid) return undefined;
    try {
      process.kill(data.pid, 0);
      return data.pid;
    } catch {
      fs.unlinkSync(lockPath);
      return undefined;
    }
  } catch {
    return undefined;
  }
}

function acquireLockAt(lockPath: string): boolean {
  const existing = checkLockAt(lockPath);
  if (existing && existing !== process.pid) return false;
  try {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid }), 'utf-8');
    return true;
  } catch {
    return false;
  }
}

function releaseLockAt(lockPath: string): void {
  try {
    if (fs.existsSync(lockPath)) {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      const data = JSON.parse(fs.readFileSync(lockPath, 'utf-8')) as {
        pid: number;
      };
      if (data.pid === process.pid) fs.unlinkSync(lockPath);
    }
  } catch {
    /* ignore cleanup errors */
  }
}

const checkLock = (): number | undefined => checkLockAt(getInstanceLockPath());
const acquireFileLock = (): boolean => acquireLockAt(getInstanceLockPath());
function releaseFileLock(): void {
  releaseLockAt(getInstanceLockPath());
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

async function startHubAndSelfJoin(
  config: Config,
  onProgress?: (text: string) => void,
): Promise<{ inviteLine: string; nickname: string }> {
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

  saved.url = baseUrl;
  saved.hub = { port: hub.port };
  saved.autoconnect = saved.autoconnect ?? true;
  saveHiveConfig(saved);

  // Self-join over loopback. An explicit full-trust invite guarantees the
  // creator's node is trusted under every trustPolicy.
  const selfInvite = hub.mintInvite('full');
  const service = new HiveService(config, {
    url: `http://127.0.0.1:${hub.port}/${hub.urlToken}`,
    passphrase,
    inviteToken: selfInvite,
  });
  service.start();
  setActiveHiveService(service);

  const inviteToken = hub.mintInvite('full');
  return {
    inviteLine: composeInvite(baseUrl, passphrase, inviteToken),
    nickname: service.getNickname(),
  };
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
  saved.autoconnect = saved.autoconnect ?? true;
  delete saved.hub; // this machine is a plain peer now
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

async function startAction(
  context: CommandContext,
): Promise<void | SlashCommandActionReturn> {
  if (getActiveHiveService()) {
    return msg('info', 'The hive is already running. Use /hive status.');
  }
  const config = getConfig(context);
  if (!config) return msg('error', 'Config not available yet.');
  // Only one node hosts the relay per machine.
  const hubHolder = checkLockAt(getHubLockPath());
  if (hubHolder && hubHolder !== process.pid) {
    return msg(
      'error',
      `A hive hub is already running on this machine (PID ${hubHolder}).\n` +
        `To add another peer here, use /hive join <invite> from a DIFFERENT working directory, ` +
        `or set AUDITARIA_HIVE_INSTANCE to a distinct value and /hive join in this one.`,
    );
  }
  // This peer instance (identity + queues) must be free.
  if (!acquireFileLock()) {
    return msg(
      'error',
      `This Auditaria instance (PID ${checkLock()}, key "${hiveInstanceKey()}") is already in a hive. ` +
        `Run a second peer from another directory or set AUDITARIA_HIVE_INSTANCE.`,
    );
  }
  if (!acquireLockAt(getHubLockPath())) {
    releaseFileLock();
    return msg(
      'error',
      'Could not acquire the hub lock — another start is in progress.',
    );
  }
  try {
    const { inviteLine, nickname } = await startHubAndSelfJoin(config, (text) =>
      context.ui.addItem({ type: 'info', text }, Date.now()),
    );
    return msg(
      'info',
      `Hive hub is up. You joined as "${nickname}" (trusted).\n\n` +
        `Invite (single-use token, full trust, 24h) — works from ANY machine, or another Auditaria on THIS machine:\n` +
        `  ${inviteLine}\n\n` +
        `Paste that line in another Auditaria (/hive join …) or into its chat for the agent to join itself.\n` +
        `On this same machine, run the other Auditaria from a different folder (or set AUDITARIA_HIVE_INSTANCE) so it is a separate peer.\n` +
        `Mint more with /hive invite (add --consult for a gated peer, --mcp for foreign CLI setup).`,
    );
  } catch (e) {
    // Tear the partially-started hub/tunnel/service down BEFORE freeing the
    // locks, so there's no window where a lock is free but the port is still
    // bound (a concurrent /hive start could otherwise double-bind).
    await teardown();
    releaseLockAt(getHubLockPath());
    releaseFileLock();
    return msg(
      'error',
      `Failed to start the hive: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

async function joinAction(
  context: CommandContext,
  args: string,
): Promise<void | SlashCommandActionReturn> {
  if (getActiveHiveService()) {
    return msg(
      'info',
      'Already connected to a hive. Use /hive leave first to join a different one.',
    );
  }
  const config = getConfig(context);
  if (!config) return msg('error', 'Config not available yet.');
  const invite = parseInvite(args);
  if (!invite) {
    return msg(
      'error',
      'Could not parse the invite. Expected: /hive join <url>#<passphrase>[.<token>]',
    );
  }
  if (!acquireFileLock()) {
    return msg(
      'error',
      `Another Auditaria instance (PID ${checkLock()}) is already running the hive on this machine.`,
    );
  }
  try {
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
  if (!service) {
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
      `\n\nForeign CLI setup (hive-mcp shim — hive_send / hive_check / blocking hive_wait):\n` +
      `  Claude Code:  claude mcp add hive -- node <auditaria>/bundle/hive-mcp.js --url "${baseUrl}" --passphrase-env HIVE_PASS --invite ${token}\n` +
      `                (set HIVE_PASS=${passphrase} in the environment)\n` +
      `  Codex:        same command under [mcp_servers.hive] in config.toml, plus tool_timeout_sec = 86400\n` +
      `  Gemini CLI:   settings.json mcpServers entry with "timeout": 86400000\n` +
      `  Copilot CLI:  works with hive_check only (60s tool cap — no hive_wait parking)\n` +
      `  One-shot hook nudge: node <auditaria>/bundle/hive-mcp.js --url "${baseUrl}" --passphrase-env HIVE_PASS --check`;
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
  const modeLine = `Mode: ${saved.mode ?? 'main'} | trust policy: ${saved.trustPolicy ?? 'open'}\n`;
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
  releaseLockAt(getHubLockPath());
  releaseFileLock();
  // Delete the machine-wide hub state (identity of the hive lives here).
  try {
    fs.rmSync(getHiveHubDir(), { recursive: true, force: true });
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
    releaseLockAt(getHubLockPath());
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
      '  /hive start                     Start a hub on this machine (+ quick tunnel) and print an invite\n' +
      '  /hive join <invite>             Join a hive with an invite line\n' +
      '  /hive invite [--consult] [--mcp]  Mint a single-use invite (default: full trust)\n' +
      '  /hive status                    Roster, queues, connection state\n' +
      '  /hive send <nick|*> <message>   Message a peer; * = hive-wide chat\n' +
      '  /hive describe <text>           Set your roster self-description\n' +
      '  /hive mode <main|approve>       Hands-free delivery vs per-message approval\n' +
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
  if (!saved.hub && !saved.url) return;
  if (!acquireFileLock()) return;
  // If this instance previously hosted the hub, only re-host when no other
  // node already holds the machine-wide hub lock.
  if (saved.hub && !acquireLockAt(getHubLockPath())) {
    releaseFileLock();
    return;
  }
  try {
    if (saved.hub) {
      await startHubAndSelfJoin(config);
    } else if (saved.url) {
      await joinHive(config, { url: saved.url, passphrase });
      activeBaseUrl = saved.url;
    }
  } catch {
    // startHubAndSelfJoin assigns activeHub/activeTunnel before the service
    // is fully up — tear the partial state down (teardown frees the hub lock),
    // then free the instance lock. Otherwise an orphan keeps the port bound.
    await teardown();
    releaseLockAt(getHubLockPath()); // in case we failed before activeHub was set
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
      description: 'Start a hive hub on this machine and print an invite',
      kind: CommandKind.BUILT_IN,
      autoExecute: true,
      action: startAction,
    },
    {
      name: 'join',
      description:
        'Join a hive. Usage: /hive join <url>#<passphrase>[.<token>]',
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
