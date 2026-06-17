/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 *
 * AUDITARIA_AGY_PROVIDER: Google Antigravity CLI (`agy`) driver.
 *
 * agy is a TUI-only Go binary with two quirks that shape this driver:
 *   1. `agy --print "<prompt>"` produces ZERO stdout unless attached to a real
 *      TTY (its "text drip" renderer only flushes to a terminal). So we drive
 *      it through a PTY (@lydell/node-pty via utils/getPty.ts) — the same
 *      backend the Claude driver uses.
 *   2. It has no JSON streaming mode, BUT it writes a clean structured JSONL
 *      transcript at
 *        ~/.gemini/antigravity-cli/brain/<cascadeId>/.system_generated/logs/transcript_full.jsonl
 *      which carries user input, model text + thinking, and tool calls + their
 *      results. We READ that transcript (tailing it live as agy works) and map
 *      its entries to ProviderEvents. Terminal scraping is only a FALLBACK for
 *      when the transcript can't be read.
 *
 * Multi-turn continuity: `agy --conversation <cascadeId> --print "<prompt>"`.
 * The id is discovered after the first turn (cache[cwd] / conversations-dir
 * diff) and reused on every subsequent turn (== our session id).
 *
 * MCP tool bridging: agy reads ~/.gemini/config/mcp_config.json and supports
 * stdio servers (command/args). That file is GLOBAL (shared with other agy
 * users), so we MERGE our `auditaria-tools` entry in with markers and remove
 * just that entry on dispose — never clobbering the user's own servers.
 */

import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import stripAnsi from 'strip-ansi';
import { getPty } from '../../utils/getPty.js';
import { killProcessGroup } from '../../utils/process-utils.js';
import {
  trackChildProcess,
  untrackChildProcess,
} from '../../utils/child-process-tracker.js';
import type {
  ProviderDriver,
  ProviderEvent,
  AttachmentFile,
} from '../types.js';
import { ProviderEventType } from '../types.js';
import type { AgyDriverConfig, AgyTranscriptEntry } from './types.js';

const DEBUG = process.env['AUDITARIA_PROVIDER_DEBUG'] === '1';
function dbg(...args: unknown[]) {
  if (DEBUG) console.log('[DEBUG][AGY_DRIVER]', ...args); // eslint-disable-line no-console
}

// AUDITARIA_AGY_PROVIDER: Map our terse model ids to agy's exact `--model`
// display names. Antigravity bills Gemini / Claude / GPT-OSS against SEPARATE
// quota pools, so each is its own selectable entry. Exported for the model
// catalog (DRY). 'auto'/undefined → omit --model (agy uses settings.json).
export const AGY_MODEL_DISPLAY: Readonly<Record<string, string>> = {
  'gemini-3.5-flash-low': 'Gemini 3.5 Flash (Low)',
  'gemini-3.5-flash-medium': 'Gemini 3.5 Flash (Medium)',
  'gemini-3.5-flash-high': 'Gemini 3.5 Flash (High)',
  'gemini-3.1-pro-low': 'Gemini 3.1 Pro (Low)',
  'gemini-3.1-pro-high': 'Gemini 3.1 Pro (High)',
  'claude-sonnet-4.6': 'Claude Sonnet 4.6 (Thinking)',
  'claude-opus-4.6': 'Claude Opus 4.6 (Thinking)',
  'gpt-oss-120b': 'GPT-OSS 120B (Medium)',
};

export function getAgyModelDisplayName(model?: string): string | undefined {
  if (!model || model === 'auto') return undefined;
  return AGY_MODEL_DISPLAY[model] ?? model;
}

// agy data layout.
const AGY_HOME = join(homedir(), '.gemini', 'antigravity-cli');
const CONV_DIR = join(AGY_HOME, 'conversations');
const BRAIN_DIR = join(AGY_HOME, 'brain');
const LOG_DIR = join(AGY_HOME, 'log');
const MCP_CONFIG_PATH = join(homedir(), '.gemini', 'config', 'mcp_config.json');

// MCP merge markers (we own the `auditaria-tools` server key).
const MCP_BRIDGE_KEY = 'auditaria-tools';

// Terminal-scrape fallback regexes.
// eslint-disable-next-line no-control-regex
const OSC_RE = /\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)/g; // OSC ... BEL/ST (title sets)
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f]/g; // keep \n \r \t

// Defaults.
const PTY_COLS = 220;
const PTY_ROWS = 50;
const POLL_INTERVAL_MS = 250; // transcript tail cadence
const FLUSH_RETRIES = 16; // post-exit retries (×150ms) for transcript flush lag
const FLUSH_INTERVAL_MS = 150;
const PRINT_TIMEOUT_S = 30 * 60; // agy --print-timeout (self-exit safety)
// Windows CreateProcessW command-line cap is ~32K wide chars. Keep the prompt
// well under it; above this we move systemContext to a file agy reads instead.
const MAX_PROMPT_CHARS = 28_000;

interface MinimalPty {
  pid: number;
  write(data: string): void;
  onData(cb: (data: string) => void): { dispose(): void };
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): {
    dispose(): void;
  };
  kill(signal?: string): void;
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Strip OSC (title sets) first, then CSI/SGR via strip-ansi, then leftover C0
 * controls — but keep \n \r \t. Used by the terminal-scrape fallback.
 */
export function cleanAgyOutput(raw: string): string {
  return stripAnsi(raw.replace(OSC_RE, '')).replace(CONTROL_RE, '');
}

/** Trim agy's "Created At:/Completed At:" tool-result preamble for display. */
function cleanToolOutput(content: string): string {
  return content
    .replace(/^Created At:.*$/gm, '')
    .replace(/^Completed At:.*$/gm, '')
    .trim();
}

/**
 * Pure mapping of ONE transcript entry to ProviderEvents. Exported for tests.
 * Mutates `pendingToolIds` (FIFO queue pairing a model's tool_calls with the
 * tool-result steps that follow). `processed: false` means "leave unprocessed
 * and re-read next poll" (a RUNNING tool result not yet complete).
 */
export function mapAgyEntry(
  entry: AgyTranscriptEntry,
  pendingToolIds: string[],
): { events: ProviderEvent[]; processed: boolean } {
  const src = (entry.source || '').toUpperCase();
  const type = (entry.type || '').toUpperCase();

  // Our own input + housekeeping rows.
  if (
    type === 'USER_INPUT' ||
    type === 'CONVERSATION_HISTORY' ||
    type === 'SYSTEM_MESSAGE' ||
    src === 'USER_EXPLICIT'
  ) {
    return { events: [], processed: true };
  }

  if (src === 'MODEL' && type === 'PLANNER_RESPONSE') {
    const events: ProviderEvent[] = [];
    if (entry.thinking) {
      events.push({ type: ProviderEventType.Thinking, text: entry.thinking });
    }
    if (entry.content) {
      events.push({ type: ProviderEventType.Content, text: entry.content });
    }
    if (Array.isArray(entry.tool_calls)) {
      for (let i = 0; i < entry.tool_calls.length; i++) {
        const tc = entry.tool_calls[i];
        const toolId = `agy-${entry.step_index}-${i}`;
        pendingToolIds.push(toolId);
        events.push({
          type: ProviderEventType.ToolUse,
          toolName: tc.name || 'tool',
          toolId,
          input: tc.args ?? {},
        });
      }
    }
    return { events, processed: true };
  }

  // Any other MODEL step is a tool RESULT (LIST_DIRECTORY, VIEW_FILE,
  // RUN_COMMAND, ...). Wait for DONE so partial output isn't emitted twice.
  if (src === 'MODEL') {
    if ((entry.status || '').toUpperCase() === 'RUNNING') {
      return { events: [], processed: false };
    }
    const toolId = pendingToolIds.shift() ?? `agy-${entry.step_index}`;
    return {
      events: [
        {
          type: ProviderEventType.ToolResult,
          toolId,
          output: cleanToolOutput(entry.content ?? ''),
          isError: false,
        },
      ],
      processed: true,
    };
  }

  // Unknown source — mark processed so we don't spin on it.
  return { events: [], processed: true };
}

export class AgyCLIDriver implements ProviderDriver {
  /** agy conversation cascade_id == our native session id. */
  private convId: string | undefined;
  private activePty: MinimalPty | null = null;
  private activePid: number | undefined;
  private mcpConfigInjected = false;
  /** Full cleaned PTY output of the previous turn, for echo-slice fallback. */
  private prevScrape = '';
  /** System-context file path written for the agy-reads-a-file path (cleanup). */
  private systemContextFilePath: string | null = null;

  readonly canResume = true;

  constructor(private readonly config: AgyDriverConfig) {
    dbg('constructor', { model: config.model, cwd: config.cwd });
  }

  getSessionId(): string | undefined {
    return this.convId;
  }

  setSessionId(id: string): void {
    this.convId = id;
  }

  resetSession(): void {
    this.convId = undefined;
    this.prevScrape = '';
  }

  async interrupt(): Promise<void> {
    this.killActive();
  }

  dispose(): void {
    this.killActive();
    this.removeMcpConfig();
    if (this.systemContextFilePath) {
      try {
        unlinkSync(this.systemContextFilePath);
      } catch {
        /* ignore */
      }
      this.systemContextFilePath = null;
    }
  }

  async *sendMessage(
    prompt: string,
    signal: AbortSignal,
    systemContext?: string,
    attachmentFiles?: AttachmentFile[],
  ): AsyncGenerator<ProviderEvent> {
    if (signal.aborted) return;

    const ptyInfo = await getPty();
    if (!ptyInfo) {
      yield {
        type: ProviderEventType.Error,
        message:
          'node-pty is not available. The agy provider requires a PTY backend ' +
          '(@lydell/node-pty or node-pty) because `agy --print` produces no ' +
          'output without a real terminal.',
      };
      return;
    }

    const exe = this.resolveAgyExe();

    this.injectMcpConfig();

    const isFirstTurn = !this.convId;
    const effectivePrompt = this.buildEffectivePrompt(
      prompt,
      systemContext,
      isFirstTurn,
      attachmentFiles,
    );
    const args = this.buildArgs(effectivePrompt);

    // Baseline: only emit transcript steps newer than what already exists.
    const before = this.listConvIds();
    let transcriptPath = this.convId
      ? this.transcriptPath(this.convId)
      : undefined;
    const processed = new Set<number>();
    if (transcriptPath) {
      for (const e of this.readTranscript(transcriptPath))
        processed.add(e.step_index);
    }

    dbg('spawn', {
      exe,
      argc: args.length,
      isFirstTurn,
      model: this.config.model,
    });

    let pty: MinimalPty;
    try {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      pty = ptyInfo.module.spawn(exe, args, {
        name: 'xterm-256color',
        cols: PTY_COLS,
        rows: PTY_ROWS,
        cwd: this.config.cwd,
        env: process.env,
      }) as MinimalPty;
    } catch (e) {
      yield {
        type: ProviderEventType.Error,
        message: `Failed to spawn agy in a PTY: ${String(e)}`,
      };
      return;
    }
    this.activePty = pty;
    this.activePid = pty.pid;
    if (pty.pid) trackChildProcess(pty.pid);

    let exited = false;
    let exitCode = 0;
    let rawBuf = '';
    const RAW_CAP = 4 * 1024 * 1024;
    const onData = pty.onData((d) => {
      rawBuf += d;
      if (rawBuf.length > RAW_CAP)
        rawBuf = rawBuf.slice(rawBuf.length - RAW_CAP);
    });
    const onExit = pty.onExit((e) => {
      exited = true;
      exitCode = e.exitCode ?? 0;
    });

    const abortHandler = () => {
      dbg('abort — killing agy process tree');
      this.killActive();
    };
    signal.addEventListener('abort', abortHandler, { once: true });

    // FIFO queue of tool_use ids awaiting their tool-result step.
    const pendingToolIds: string[] = [];
    let emittedAny = false;

    try {
      // Live tail: poll the transcript while agy works.
      while (!exited && !signal.aborted) {
        if (!this.convId) {
          this.convId = this.discoverConvId(before);
          if (this.convId) transcriptPath = this.transcriptPath(this.convId);
        }
        if (transcriptPath) {
          for (const ev of this.drainTranscript(
            transcriptPath,
            processed,
            pendingToolIds,
          )) {
            emittedAny = true;
            yield ev;
          }
        }
        await delay(POLL_INTERVAL_MS);
      }

      if (signal.aborted) return;

      // Final flush: agy may write the last PLANNER_RESPONSE just after exit.
      if (!this.convId) {
        this.convId = this.discoverConvId(before);
        if (this.convId) transcriptPath = this.transcriptPath(this.convId);
      }
      for (let i = 0; i < FLUSH_RETRIES; i++) {
        let gotSomething = false;
        if (transcriptPath) {
          for (const ev of this.drainTranscript(
            transcriptPath,
            processed,
            pendingToolIds,
          )) {
            emittedAny = true;
            gotSomething = true;
            yield ev;
          }
        }
        // Stop early once we have content and no pending tool results.
        if (emittedAny && pendingToolIds.length === 0 && !gotSomething) break;
        await delay(FLUSH_INTERVAL_MS);
      }

      // Transcript yielded nothing. Before scraping the PTY as a "response",
      // classify it: an expired token makes agy print an OAuth prompt to the
      // terminal, which must surface as an auth ERROR — never as the answer.
      const cleaned = cleanAgyOutput(rawBuf);
      if (!emittedAny) {
        const reason = this.classifyFailure(cleaned);
        if (reason) {
          emittedAny = true;
          yield { type: ProviderEventType.Error, message: reason };
        } else {
          const text = this.extractScrapedResponse(rawBuf);
          if (text) {
            emittedAny = true;
            yield { type: ProviderEventType.Content, text };
          }
        }
      }
      // Remember this turn's full scrape for the next turn's echo-slice.
      this.prevScrape = cleaned.trim();

      // Still nothing — emit a generic error.
      if (!emittedAny) {
        yield {
          type: ProviderEventType.Error,
          message:
            exitCode !== 0
              ? `agy exited with code ${exitCode} and produced no response.`
              : 'agy produced no response. It may be unauthenticated or rate-limited; run `agy` interactively to check.',
        };
      }

      yield { type: ProviderEventType.Finished };
    } finally {
      signal.removeEventListener('abort', abortHandler);
      onData.dispose();
      onExit.dispose();
      if (this.activePid) untrackChildProcess(this.activePid);
      this.activePty = null;
      this.activePid = undefined;
    }
  }

  // ─── transcript reading ────────────────────────────────────────────────

  /** Path to the (preferred untruncated) transcript for a conversation id. */
  private transcriptPath(convId: string): string {
    const dir = join(BRAIN_DIR, convId, '.system_generated', 'logs');
    const full = join(dir, 'transcript_full.jsonl');
    if (existsSync(full)) return full;
    return join(dir, 'transcript.jsonl');
  }

  /** Parse all complete JSON lines from the transcript (skips partial tail). */
  private readTranscript(path: string): AgyTranscriptEntry[] {
    let content: string;
    try {
      content = readFileSync(path, 'utf-8');
    } catch {
      return [];
    }
    const out: AgyTranscriptEntry[] = [];
    for (const line of content.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
        out.push(JSON.parse(t) as AgyTranscriptEntry);
      } catch {
        /* partial last line — will be complete on the next poll */
      }
    }
    return out;
  }

  /**
   * Read the transcript and yield ProviderEvents for any step not yet in
   * `processed`. Tool results (RUNNING) are left unprocessed until DONE so we
   * don't emit them twice. Mutates `processed` and `pendingToolIds`.
   */
  private *drainTranscript(
    path: string,
    processed: Set<number>,
    pendingToolIds: string[],
  ): Generator<ProviderEvent> {
    for (const e of this.readTranscript(path)) {
      if (processed.has(e.step_index)) continue;
      const { events, processed: done } = mapAgyEntry(e, pendingToolIds);
      for (const ev of events) yield ev;
      if (done) processed.add(e.step_index);
    }
  }

  // ─── scrape fallback ───────────────────────────────────────────────────

  /**
   * Fallback when the transcript is unavailable: extract the newest response
   * from the PTY output. On resume, agy echoes ALL prior model turns verbatim
   * then the new one — so the new turn's cleaned output is
   * `prevTurnCleaned + sep + newResponse`; slice the prior prefix off.
   * (Validated empirically against live agy output.)
   */
  private extractScrapedResponse(rawBuf: string): string {
    const cleaned = cleanAgyOutput(rawBuf).trim();
    if (!cleaned) return '';
    if (this.prevScrape && cleaned.startsWith(this.prevScrape)) {
      return cleaned.slice(this.prevScrape.length).replace(/^[\s\r\n]+/, '');
    }
    return cleaned;
  }

  // ─── conversation id discovery ─────────────────────────────────────────

  private listConvIds(): Set<string> {
    const out = new Set<string>();
    try {
      for (const f of readdirSync(CONV_DIR)) {
        if (f.endsWith('.db')) out.add(f.slice(0, -3));
      }
    } catch {
      /* dir may not exist yet */
    }
    return out;
  }

  /**
   * Find the conversation id agy created this turn via dir-diff against the
   * pre-spawn snapshot. We deliberately do NOT consult
   * `cache/last_conversations.json` — it's keyed by cwd and rewritten by EVERY
   * agy process (the documented "poisoning race"), so it can point at another
   * run's conversation. If multiple new dbs appear (concurrent agy elsewhere),
   * pick the newest by mtime.
   */
  private discoverConvId(before: Set<string>): string | undefined {
    const after = this.listConvIds();
    const fresh = [...after].filter((x) => !before.has(x));
    if (fresh.length === 0) return undefined; // not created yet — poll again
    if (fresh.length === 1) return fresh[0];
    let newest: string | undefined;
    let newestM = -1;
    for (const id of fresh) {
      try {
        const m = statSync(join(CONV_DIR, `${id}.db`)).mtimeMs;
        if (m > newestM) {
          newestM = m;
          newest = id;
        }
      } catch {
        /* ignore */
      }
    }
    return newest ?? fresh[0];
  }

  // ─── arg/prompt building ───────────────────────────────────────────────

  private buildArgs(effectivePrompt: string): string[] {
    // CRITICAL (validated live): `--print <prompt>` must come LAST. If a bare
    // bool flag like `--dangerously-skip-permissions` immediately follows the
    // prompt value, agy absorbs the FLAG NAME as the prompt (the recorded user
    // request becomes literally "--dangerously-skip-permissions"). Putting all
    // value-taking and bool flags before `--print <prompt>` avoids this.
    const args: string[] = [];
    const display = getAgyModelDisplayName(this.config.model);
    if (display) args.push('--model', display);
    if (this.convId) args.push('--conversation', this.convId);
    args.push('--dangerously-skip-permissions');
    args.push('--add-dir', this.config.cwd);
    args.push('--print-timeout', `${PRINT_TIMEOUT_S}s`);
    args.push('--print', effectivePrompt); // keep LAST — see comment above
    return args;
  }

  /**
   * On the first turn, agy has no `--append-system-prompt`, so the system
   * context joins the conversation as part of the prompt. If that would blow
   * the Windows argv cap, write it to a file and have agy read it instead.
   * Resumed turns already have the context in the conversation.
   */
  private buildEffectivePrompt(
    prompt: string,
    systemContext: string | undefined,
    isFirstTurn: boolean,
    attachmentFiles?: AttachmentFile[],
  ): string {
    let body = prompt;

    // Reference any image attachments by path (agy reads files via --add-dir).
    if (attachmentFiles?.length) {
      const refs = attachmentFiles.map((f) => `- ${f.filePath}`).join('\n');
      body = `${body}\n\n[Attached files — view them as needed]\n${refs}`;
    }

    if (!isFirstTurn || !systemContext) return body;

    const inline = `${systemContext}\n\n---\n\n${body}`;
    if (inline.length <= MAX_PROMPT_CHARS) return inline;

    // Too big for argv — spill the context to a file agy can read.
    try {
      const path = this.writeSystemContextFile(systemContext);
      return (
        `Before responding, read your full operating instructions from this ` +
        `file using your view-file tool: ${path}\n\n` +
        `Then handle this request:\n\n${body}`
      );
    } catch {
      // Last resort: truncate inline.
      return inline.slice(0, MAX_PROMPT_CHARS);
    }
  }

  private writeSystemContextFile(content: string): string {
    const dir = join(this.config.cwd, '.auditaria');
    mkdirSync(dir, { recursive: true });
    const name = this.config.promptFileId
      ? `.agy-system-${this.config.promptFileId}.md`
      : '.agy-system-context.md';
    const path = join(dir, name);
    writeFileSync(path, content, 'utf-8');
    this.systemContextFilePath = path;
    return path;
  }

  // ─── MCP config merge / restore (global ~/.gemini/config/mcp_config.json) ─

  private injectMcpConfig(): void {
    if (this.mcpConfigInjected) return;
    const hasBridge =
      this.config.toolBridgePort && this.config.toolBridgeScript;
    const userServers = this.config.mcpServers ?? {};
    if (!hasBridge && Object.keys(userServers).length === 0) return;

    let root: { mcpServers?: Record<string, unknown> } = {};
    try {
      if (existsSync(MCP_CONFIG_PATH)) {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
        root = JSON.parse(
          readFileSync(MCP_CONFIG_PATH, 'utf-8'),
        ) as typeof root;
      }
    } catch {
      root = {};
    }
    if (!root.mcpServers) root.mcpServers = {};

    // Auditaria tool bridge (stdio MCP → node bundle).
    if (hasBridge) {
      const bridgeArgs = [
        this.config.toolBridgeScript!,
        '--port',
        String(this.config.toolBridgePort),
      ];
      for (const name of this.config.toolBridgeExclude ?? []) {
        bridgeArgs.push('--exclude', name);
      }
      root.mcpServers[MCP_BRIDGE_KEY] = {
        command: process.execPath,
        args: bridgeArgs,
        disabled: false,
      };
    }

    // User MCP servers (stdio or http) — only add ones we can map; never
    // overwrite an existing key the user already defined.
    for (const [name, server] of Object.entries(userServers)) {
      if (name === MCP_BRIDGE_KEY) continue;
      if (root.mcpServers[name]) continue;
      if (server.command) {
        root.mcpServers[name] = {
          command: server.command,
          args: server.args ?? [],
          ...(server.env && { env: server.env }),
          disabled: false,
        };
      } else if (server.url || server.httpUrl) {
        root.mcpServers[name] = {
          serverUrl: server.url || server.httpUrl,
          disabled: false,
        };
      }
    }

    try {
      mkdirSync(join(homedir(), '.gemini', 'config'), { recursive: true });
      writeFileSync(MCP_CONFIG_PATH, JSON.stringify(root, null, 2));
      this.mcpConfigInjected = true;
      dbg('merged MCP bridge into', MCP_CONFIG_PATH);
    } catch (e) {
      dbg('failed to write agy mcp_config.json', e);
    }
  }

  private removeMcpConfig(): void {
    if (!this.mcpConfigInjected) return;
    this.mcpConfigInjected = false;
    try {
      if (!existsSync(MCP_CONFIG_PATH)) return;
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      const root = JSON.parse(readFileSync(MCP_CONFIG_PATH, 'utf-8')) as {
        mcpServers?: Record<string, unknown>;
      };
      if (root.mcpServers && root.mcpServers[MCP_BRIDGE_KEY]) {
        delete root.mcpServers[MCP_BRIDGE_KEY];
        writeFileSync(MCP_CONFIG_PATH, JSON.stringify(root, null, 2));
        dbg('removed MCP bridge from', MCP_CONFIG_PATH);
      }
    } catch {
      /* leave it — better than corrupting the user's config */
    }
  }

  // ─── failure classification (agy buries quota/auth in its cli log) ───────

  private classifyFailure(scraped: string): string | undefined {
    const haystack = scraped + '\n' + this.readLatestCliLogTail();
    if (
      /not logged in|authentication failed|authentication required|authentication timed out|invalid.?grant|not logged into Antigravity|visit the URL to log in|waiting for authentication|\b401\b/i.test(
        haystack,
      )
    ) {
      return 'agy is not authenticated (or its token expired). Run `agy` interactively to sign in to Antigravity, then retry.';
    }
    if (
      /quota.*exceeded|resource_exhausted|rate.?limit|\b429\b/i.test(haystack)
    ) {
      return 'agy hit an Antigravity quota/rate limit. Wait for the quota window to reset, or switch model family / provider.';
    }
    return undefined;
  }

  private readLatestCliLogTail(): string {
    try {
      const logs = readdirSync(LOG_DIR)
        .filter((f) => f.startsWith('cli-') && f.endsWith('.log'))
        .map((f) => ({ f, m: statSync(join(LOG_DIR, f)).mtimeMs }))
        .sort((a, b) => b.m - a.m);
      if (!logs.length) return '';
      return readFileSync(join(LOG_DIR, logs[0].f), 'utf-8').slice(-4000);
    } catch {
      return '';
    }
  }

  // ─── process resolution / teardown ─────────────────────────────────────

  private resolveAgyExe(): string {
    const fromEnv = process.env['AGY_EXE'];
    if (fromEnv && existsSync(fromEnv)) return fromEnv;
    if (process.platform === 'win32') {
      const known = join(
        homedir(),
        'AppData',
        'Local',
        'agy',
        'bin',
        'agy.EXE',
      );
      if (existsSync(known)) return known;
    }
    // Fall back to a bare `agy` and let the PTY/PATH resolve it. If it isn't
    // installed the spawn throws and sendMessage surfaces a clear error.
    return 'agy';
  }

  private killActive(): void {
    const pid = this.activePid;
    if (this.activePty) {
      try {
        this.activePty.kill();
      } catch {
        /* ignore */
      }
    }
    // agy spawns child processes that survive a plain kill — reap the tree.
    if (pid) {
      void killProcessGroup({ pid, escalate: true });
    }
  }
}
