/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 *
 * Probe what happens when Claude calls its AskUserQuestion tool through
 * our PTY driver. This is the actual UX gap: when Claude wants to ask the
 * user "should I do 1/2/3/4/Other?", does our driver surface that, or
 * does it hang?
 *
 * Run with:
 *   $env:AUDITARIA_PROVIDER_DEBUG=1; npx tsx scripts/test-claude-askuser.ts
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeCLIDriver } from '../packages/core/src/providers/claude/claudeCLIDriver.js';
import { ProviderEventType } from '../packages/core/src/providers/types.js';

const PROMPT = `I need your help picking a deployment strategy for a small Node.js
HTTP server (Express, ~500 RPS, on a single VPS with 4GB RAM).

You MUST use your AskUserQuestion tool to ask me to choose between these
specific options before you give any recommendation:

  1. Docker + nginx reverse proxy
  2. PM2 process manager directly
  3. systemd service unit
  4. Kubernetes (overkill but let me decide)

Do NOT proceed without asking via the tool. Do not assume my preference.
The tool call is required for this turn.`;

async function main() {
  console.log('=== AskUserQuestion probe ===');
  console.log('Prompt asks Claude to use its AskUserQuestion tool.\n');

  const beforeFiles = new Set(readdirSync(tmpdir()));

  const driver = new ClaudeCLIDriver({
    model: 'sonnet', // sonnet handles tool selection better than haiku
    cwd: process.cwd(),
    permissionMode: 'bypassPermissions',
  });

  const controller = new AbortController();
  const WATCHDOG_MS = 60_000;
  let hung = false;
  const watchdog = setTimeout(() => {
    hung = true;
    console.log(
      `\n[WATCHDOG +${WATCHDOG_MS / 1000}s] aborting — driver was still waiting.`,
    );
    controller.abort();
  }, WATCHDOG_MS);

  const start = Date.now();
  const events: Array<{ ms: number; type: string; detail?: unknown }> = [];

  try {
    for await (const event of driver.sendMessage(PROMPT, controller.signal)) {
      const ms = Date.now() - start;
      const type = (event as { type: string }).type;
      events.push({ ms, type, detail: event });
      if (type === ProviderEventType.ToolUse) {
        const name = (event as { toolName: string }).toolName;
        const input = (event as { input: Record<string, unknown> }).input;
        console.log(`  [+${(ms / 1000).toFixed(1)}s] ToolUse: ${name}`);
        console.log(`    input: ${JSON.stringify(input).slice(0, 500)}`);
      } else if (type === ProviderEventType.ToolResult) {
        const output = (event as { output: string }).output;
        console.log(
          `  [+${(ms / 1000).toFixed(1)}s] ToolResult: ${JSON.stringify(output).slice(0, 300)}`,
        );
      } else if (type === ProviderEventType.Content) {
        const text = (event as { text: string }).text;
        console.log(
          `  [+${(ms / 1000).toFixed(1)}s] Content (${text.length} chars): ${JSON.stringify(text.slice(0, 200))}`,
        );
      } else if (type === ProviderEventType.Error) {
        console.log(
          `  [+${(ms / 1000).toFixed(1)}s] Error: ${(event as { message: string }).message}`,
        );
      } else {
        console.log(`  [+${(ms / 1000).toFixed(1)}s] ${type}`);
      }
    }
  } catch (e) {
    console.error(`  threw:`, e instanceof Error ? e.message : String(e));
  } finally {
    clearTimeout(watchdog);
    // Don't dispose — keep hook files for inspection
    await driver.interrupt();
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log('');
  console.log(
    `OUTCOME: ${hung ? '⚠ HUNG' : '✓ completed'} | events=${events.length} | elapsed=${elapsed}s`,
  );

  // Find and dump the hook events file.
  const newHookFiles = readdirSync(tmpdir()).filter(
    (f) => f.startsWith('auditaria-claude-hook-events-') && !beforeFiles.has(f),
  );
  if (newHookFiles.length === 0) {
    console.log('No hook event file found.');
  } else {
    const newest = newHookFiles
      .map((f) => ({ f, mtime: statSync(join(tmpdir(), f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)[0].f;
    const fullPath = join(tmpdir(), newest);
    console.log(`\nHook events file: ${fullPath}`);

    const lines = readFileSync(fullPath, 'utf-8')
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => {
        try {
          return JSON.parse(l) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .filter((x): x is Record<string, unknown> => x !== null);

    console.log(`Hook events captured: ${lines.length}\n`);
    for (const ev of lines) {
      const eventName = String(ev['event'] ?? '?');
      const payload = ev['payload'] as Record<string, unknown> | undefined;
      console.log(`  --- ${eventName} ---`);
      if (payload) {
        // Show ALL keys (small payloads), truncate values
        for (const [k, v] of Object.entries(payload)) {
          const vStr = typeof v === 'string' ? v : JSON.stringify(v);
          console.log(`    ${k}: ${vStr.slice(0, 300)}`);
        }
      }
    }
  }

  process.exit(0);
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
