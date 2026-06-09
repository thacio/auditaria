/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 *
 * Test what keystrokes Claude's AskUserQuestion picker accepts.
 *
 * Strategy: extend the driver via a quick subclass that exposes the
 * underlying PTY. Wait for PreToolUse(AskUserQuestion) to fire, then send
 * a candidate keystroke sequence, observe what Claude does next.
 *
 * We try several candidates by running multiple sessions:
 *   - "1\r"            (number digit + Enter)
 *   - "\x1b[B\r"       (Down arrow + Enter, to pick the SECOND option)
 *   - "Docker\r"       (typing label text + Enter — depends if picker filters)
 *
 * For each, we observe whether Claude proceeds to a Content event with a
 * reply that references the chosen option.
 */

import { ClaudeCLIDriver } from '../packages/core/src/providers/claude/claudeCLIDriver.js';
import { ProviderEventType } from '../packages/core/src/providers/types.js';

// AUDITARIA: Hack to access the activePty from outside. We'll set a global
// hook in the driver's private state via reflection of a TypeScript any cast.
// In real code we'd add a clean writeRawInput() method. This is a probe.

const PROMPT = `I'm picking a deployment strategy. You MUST use your
AskUserQuestion tool to ask me to choose between these options before
recommending anything:

  Option A: Docker + nginx reverse proxy
  Option B: PM2 process manager directly
  Option C: systemd service unit
  Option D: Kubernetes

When I pick, briefly say which option I picked and then stop. Do not run
any other tools.`;

interface Scenario {
  label: string;
  response: string;
  expectedOption: string; // what we expect the model to say I picked
}

const SCENARIOS: Scenario[] = [
  {
    label: 'digit "1" + Enter',
    response: '1\r',
    expectedOption: 'A',
  },
  {
    label: 'Down-arrow + Enter (selects 2nd option)',
    response: '\x1b[B\r',
    expectedOption: 'B',
  },
  {
    label: 'Tab to confirm focused row',
    response: '\t\r',
    expectedOption: 'A', // tab might just confirm default
  },
];

async function runScenario(s: Scenario): Promise<void> {
  console.log('\n────────────────────────────────────────────────────────');
  console.log(`SCENARIO: ${s.label}`);
  console.log(
    `Sending bytes: ${JSON.stringify(s.response)} (after PreToolUse fires)`,
  );
  console.log('────────────────────────────────────────────────────────');

  const driver = new ClaudeCLIDriver({
    model: 'sonnet',
    cwd: process.cwd(),
    permissionMode: 'bypassPermissions',
  });

  const controller = new AbortController();
  setTimeout(() => controller.abort(), 90_000);

  let sentResponse = false;

  const start = Date.now();
  let textOutput = '';

  try {
    for await (const event of driver.sendMessage(PROMPT, controller.signal)) {
      const ms = Date.now() - start;
      const type = (event as { type: string }).type;

      if (type === ProviderEventType.ToolUse) {
        const name = (event as { toolName: string }).toolName;
        console.log(`  [+${(ms / 1000).toFixed(1)}s] ToolUse: ${name}`);
        if (name === 'AskUserQuestion' && !sentResponse) {
          sentResponse = true;
          // Give the TUI a moment to render the picker, then write our response.
          // Access the private activePty field via untyped cast.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const pty = (driver as any).activePty as {
            write(d: string): void;
            pid: number;
          } | null;
          if (!pty) {
            console.log('  ! activePty is null — cannot send response');
            continue;
          }
          console.log(
            `  ! waiting 1.5s for picker render, then writing keystrokes`,
          );
          setTimeout(() => {
            try {
              pty.write(s.response);
              console.log(`  ! wrote ${JSON.stringify(s.response)} to PTY`);
            } catch (e) {
              console.error('  ! pty.write threw:', e);
            }
          }, 1500);
        }
      } else if (type === ProviderEventType.ToolResult) {
        console.log(`  [+${(ms / 1000).toFixed(1)}s] ToolResult`);
      } else if (type === ProviderEventType.Content) {
        const text = (event as { text: string }).text;
        textOutput += text;
      } else if (type === ProviderEventType.Finished) {
        console.log(`  [+${(ms / 1000).toFixed(1)}s] Finished`);
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
    await driver.interrupt();
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`\nElapsed: ${elapsed}s`);
  console.log(`Claude said: ${JSON.stringify(textOutput.slice(0, 400))}`);
  console.log(`Expected: option ${s.expectedOption}`);
  console.log(
    `Worked: ${textOutput.toUpperCase().includes(s.expectedOption.toUpperCase()) ? '✓ YES' : '✗ NO / inconclusive'}`,
  );
}

async function main() {
  console.log('=== AskUserQuestion response probe ===');
  console.log('Tries different keystroke sequences to find which one works.\n');
  for (const s of SCENARIOS) {
    try {
      await runScenario(s);
    } catch (e) {
      console.error('Scenario crashed:', e);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.log('\n=== done ===');
  process.exit(0);
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
