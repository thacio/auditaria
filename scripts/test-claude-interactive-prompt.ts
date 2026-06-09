/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 *
 * Probe how Claude's interactive prompts (permission dialog, /resume picker,
 * etc.) behave through our PTY driver. This is observation-only: we don't
 * change driver behavior, just record what events flow and how the driver
 * reacts to a moment where Claude expects user input.
 *
 * Run with:
 *   $env:AUDITARIA_PROVIDER_DEBUG=1; npx tsx scripts/test-claude-interactive-prompt.ts
 *
 * The DEBUG env var enables raw PTY output + Notification hook payload
 * logging, both essential for diagnosing what Claude shows.
 *
 * Each scenario runs with a 45s watchdog. If the driver hangs (as expected
 * for the cases where Stop never fires), the watchdog fires the abort
 * signal and we record "HUNG".
 */

import { ClaudeCLIDriver } from '../packages/core/src/providers/claude/claudeCLIDriver.js';
import { ProviderEventType } from '../packages/core/src/providers/types.js';

interface Scenario {
  label: string;
  prompt: string;
  permissionMode?: string;
  watchdogMs: number;
  notes: string;
}

const SCENARIOS: Scenario[] = [
  {
    label: 'Permission dialog (permission-mode=default)',
    prompt:
      'Use your Bash tool to run the command `echo hello-from-bash` and ' +
      'report exactly what stdout it produced. Do not skip the tool call.',
    permissionMode: 'default', // forces Claude to ask before running Bash
    watchdogMs: 45_000,
    notes:
      'Expect: Bash tool requested → permission prompt → driver hangs because ' +
      'Stop never fires while Claude waits for human input.',
  },
  {
    label: '/resume slash-command picker',
    prompt: '/resume',
    permissionMode: 'bypassPermissions',
    watchdogMs: 30_000,
    notes:
      'Expect: TUI shows a session picker. UserPromptExpansion may fire. ' +
      'Stop probably never fires.',
  },
  {
    label: '/model slash-command picker',
    prompt: '/model',
    permissionMode: 'bypassPermissions',
    watchdogMs: 30_000,
    notes:
      'Expect: TUI shows model picker. UserPromptExpansion fires. Stop ' +
      'probably never fires.',
  },
];

async function runScenario(s: Scenario): Promise<void> {
  console.log('\n────────────────────────────────────────────────────────');
  console.log(`SCENARIO: ${s.label}`);
  console.log(`Prompt:   ${JSON.stringify(s.prompt)}`);
  console.log(`Mode:     ${s.permissionMode ?? '(default)'}`);
  console.log(`Notes:    ${s.notes}`);
  console.log('────────────────────────────────────────────────────────');

  const driver = new ClaudeCLIDriver({
    model: 'haiku',
    cwd: process.cwd(),
    permissionMode: s.permissionMode,
  });

  const controller = new AbortController();
  let hung = false;
  const watchdog = setTimeout(() => {
    hung = true;
    console.log(
      `\n[WATCHDOG +${(s.watchdogMs / 1000).toFixed(0)}s] aborting — driver was still waiting for an event.`,
    );
    controller.abort();
  }, s.watchdogMs);

  const start = Date.now();
  const events: Array<{ ms: number; type: string; detail?: unknown }> = [];

  try {
    for await (const event of driver.sendMessage(s.prompt, controller.signal)) {
      const ms = Date.now() - start;
      const type = (event as { type: string }).type;
      events.push({ ms, type, detail: event });
      if (type === ProviderEventType.Content) {
        const text = (event as { text: string }).text;
        console.log(
          `  [+${(ms / 1000).toFixed(1)}s] Content (${text.length} chars): ${JSON.stringify(text.slice(0, 120))}`,
        );
      } else if (type === ProviderEventType.ToolUse) {
        const name = (event as { toolName: string }).toolName;
        console.log(`  [+${(ms / 1000).toFixed(1)}s] ToolUse: ${name}`);
      } else if (type === ProviderEventType.ToolResult) {
        console.log(`  [+${(ms / 1000).toFixed(1)}s] ToolResult`);
      } else if (type === ProviderEventType.Error) {
        const msg = (event as { message: string }).message;
        console.log(`  [+${(ms / 1000).toFixed(1)}s] Error: ${msg}`);
      } else if (type === ProviderEventType.Finished) {
        const usage = (event as { usage?: unknown }).usage;
        console.log(
          `  [+${(ms / 1000).toFixed(1)}s] Finished. usage=${JSON.stringify(usage)}`,
        );
      } else {
        console.log(`  [+${(ms / 1000).toFixed(1)}s] ${type}`);
      }
    }
  } catch (e) {
    console.error(
      `  [+${((Date.now() - start) / 1000).toFixed(1)}s] threw:`,
      e instanceof Error ? e.message : String(e),
    );
  } finally {
    clearTimeout(watchdog);
    driver.dispose();
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log('');
  console.log(
    `OUTCOME: ${hung ? '⚠ HUNG (watchdog fired)' : '✓ completed cleanly'}`,
  );
  console.log(`Total events: ${events.length}, elapsed: ${elapsed}s`);
  const types = events.map((e) => e.type).join(', ');
  console.log(`Event sequence: ${types || '(none)'}`);
}

async function main() {
  console.log('=== Interactive-prompt behavior probe ===');
  console.log(
    'Set AUDITARIA_PROVIDER_DEBUG=1 to see raw PTY + Notification details.',
  );
  console.log(
    'DEBUG enabled:',
    process.env['AUDITARIA_PROVIDER_DEBUG'] === '1',
  );

  for (const s of SCENARIOS) {
    try {
      await runScenario(s);
    } catch (e) {
      console.error('Scenario crashed:', e);
    }
    // brief pause between scenarios
    await new Promise((r) => setTimeout(r, 500));
  }

  console.log('\n=== Probe complete ===');
  process.exit(0);
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
