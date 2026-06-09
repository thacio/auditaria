/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 *
 * Specifically wait LONG on /resume picker to see if the idle_prompt
 * Notification hook eventually fires.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeCLIDriver } from '../packages/core/src/providers/claude/claudeCLIDriver.js';

async function main() {
  console.log('=== Idle Notification probe ===');
  console.log(
    'Will type /resume and wait 90s to see if any Notification fires\n',
  );

  const beforeFiles = new Set(readdirSync(tmpdir()));

  const driver = new ClaudeCLIDriver({
    model: 'haiku',
    cwd: process.cwd(),
    permissionMode: 'bypassPermissions',
  });

  const controller = new AbortController();
  setTimeout(() => controller.abort(), 90_000);

  const start = Date.now();
  // Sample the hook events file periodically so we see notifications as
  // they appear, not just at the end.
  const sampleInterval = setInterval(() => {
    const newHookFiles = readdirSync(tmpdir()).filter(
      (f) =>
        f.startsWith('auditaria-claude-hook-events-') && !beforeFiles.has(f),
    );
    if (newHookFiles.length === 0) return;
    const newest = newHookFiles
      .map((f) => ({ f, mtime: statSync(join(tmpdir(), f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)[0].f;
    try {
      const content = readFileSync(join(tmpdir(), newest), 'utf-8');
      const events = content
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
      const elapsed = ((Date.now() - start) / 1000).toFixed(0);
      const names = events.map((e) => String(e['event'] ?? '?')).join(',');
      console.log(`[+${elapsed}s] hook events so far: [${names}]`);
    } catch {
      /* ignore */
    }
  }, 10_000);

  try {
    for await (const event of driver.sendMessage(
      '/resume',
      controller.signal,
    )) {
      const ms = Date.now() - start;
      const type = (event as { type: string }).type;
      console.log(`  [+${(ms / 1000).toFixed(1)}s] yielded: ${type}`);
    }
  } catch (e) {
    console.error('  threw:', e instanceof Error ? e.message : String(e));
  } finally {
    clearInterval(sampleInterval);
    await driver.interrupt();
  }

  // Final dump
  const newHookFiles = readdirSync(tmpdir()).filter(
    (f) => f.startsWith('auditaria-claude-hook-events-') && !beforeFiles.has(f),
  );
  if (newHookFiles.length) {
    const newest = newHookFiles
      .map((f) => ({ f, mtime: statSync(join(tmpdir(), f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)[0].f;
    console.log('\nFinal hook event file:', newest);
    const content = readFileSync(join(tmpdir(), newest), 'utf-8');
    console.log(content);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
