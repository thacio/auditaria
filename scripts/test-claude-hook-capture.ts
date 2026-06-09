/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 *
 * Capture-only probe: run a scenario that should hit a Notification hook,
 * then read the hook events JSONL to see EXACTLY which hooks fired.
 * Does NOT call driver.dispose() — keeps the hook file readable.
 *
 * Run with:
 *   npx tsx scripts/test-claude-hook-capture.ts
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeCLIDriver } from '../packages/core/src/providers/claude/claudeCLIDriver.js';
import { ProviderEventType } from '../packages/core/src/providers/types.js';

interface Scenario {
  label: string;
  prompt: string;
  permissionMode?: string;
  watchdogMs: number;
}

const SCENARIOS: Scenario[] = [
  {
    label: 'Write tool (default mode → permission dialog expected)',
    prompt:
      'Use your Write tool to create a new file at ' +
      'C:/projects/auditaria/.auditaria/probe-write-test.txt with the ' +
      'content "probe". Do not skip the tool.',
    permissionMode: 'default',
    watchdogMs: 30_000,
  },
  {
    label: '/resume (picker — known hang)',
    prompt: '/resume',
    permissionMode: 'bypassPermissions',
    watchdogMs: 20_000,
  },
  {
    label: 'Bash rm (destructive — permission expected)',
    prompt:
      'Use your Bash tool to run `del nonexistent.txt` (Windows) or ' +
      '`rm nonexistent.txt` (Unix). It is fine if the file does not exist; ' +
      'I just want to test the tool call.',
    permissionMode: 'default',
    watchdogMs: 30_000,
  },
];

async function runScenario(s: Scenario): Promise<void> {
  console.log('\n────────────────────────────────────────────────────────');
  console.log(`SCENARIO: ${s.label}`);
  console.log('────────────────────────────────────────────────────────');

  // Snapshot tmpdir entries BEFORE this scenario so we can identify the new
  // hook event file afterwards.
  const beforeFiles = new Set(readdirSync(tmpdir()));

  const driver = new ClaudeCLIDriver({
    model: 'haiku',
    cwd: process.cwd(),
    permissionMode: s.permissionMode,
  });

  const controller = new AbortController();
  let hung = false;
  const watchdog = setTimeout(() => {
    hung = true;
    controller.abort();
  }, s.watchdogMs);

  const start = Date.now();
  let eventCount = 0;
  try {
    for await (const event of driver.sendMessage(s.prompt, controller.signal)) {
      eventCount++;
      const ms = Date.now() - start;
      const type = (event as { type: string }).type;
      if (type === ProviderEventType.Content) {
        console.log(
          `  [+${(ms / 1000).toFixed(1)}s] Content: ${JSON.stringify((event as { text: string }).text.slice(0, 100))}`,
        );
      } else if (type === ProviderEventType.ToolUse) {
        console.log(
          `  [+${(ms / 1000).toFixed(1)}s] ToolUse: ${(event as { toolName: string }).toolName}`,
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
    console.error('  threw:', e instanceof Error ? e.message : String(e));
  } finally {
    clearTimeout(watchdog);
    // Kill PTY but DO NOT dispose — keeps hook files readable.
    await driver.interrupt();
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(
    `OUTCOME: ${hung ? '⚠ HUNG' : '✓ completed'} | events=${eventCount} | elapsed=${elapsed}s`,
  );

  // Find the hook event file created by this scenario.
  const afterFiles = readdirSync(tmpdir());
  const newHookFiles = afterFiles.filter(
    (f) => f.startsWith('auditaria-claude-hook-events-') && !beforeFiles.has(f),
  );
  if (newHookFiles.length === 0) {
    console.log('⚠ no hook events file located');
    return;
  }
  // Take the newest one.
  const newest = newHookFiles
    .map((f) => ({ f, mtime: statSync(join(tmpdir(), f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)[0].f;
  const fullPath = join(tmpdir(), newest);
  console.log(`Hook events file: ${fullPath}`);

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

  console.log(`Hook events captured: ${lines.length}`);
  for (const ev of lines) {
    const eventName = String(ev['event'] ?? '?');
    const payload = ev['payload'] as Record<string, unknown> | undefined;
    const interesting: Record<string, unknown> = {};
    if (payload) {
      for (const k of [
        'notification_type',
        'title',
        'message',
        'command_name',
        'expansion_type',
        'tool_name',
        'trigger',
        'error_type',
      ]) {
        if (k in payload) interesting[k] = payload[k];
      }
    }
    const intStr = Object.keys(interesting).length
      ? ' ' + JSON.stringify(interesting)
      : '';
    console.log(`    ${eventName}${intStr}`);
  }
}

async function main() {
  console.log('=== Hook capture probe ===');
  for (const s of SCENARIOS) {
    try {
      await runScenario(s);
    } catch (e) {
      console.error('Scenario crashed:', e);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  console.log('\n=== done ===');
  process.exit(0);
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
