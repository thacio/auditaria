/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 *
 * Single scenario with full PTY raw visibility. Wait longer for picker
 * to render, send a candidate keystroke sequence, observe.
 *
 * Run with: $env:AUDITARIA_PROVIDER_DEBUG=1; npx tsx scripts/test-claude-askuser-keys.ts <variant>
 * where <variant> is one of: digit, arrow, label, type-and-enter, ss3-arrow
 */

import { ClaudeCLIDriver } from '../packages/core/src/providers/claude/claudeCLIDriver.js';
import { ProviderEventType } from '../packages/core/src/providers/types.js';

const VARIANT = (process.argv[2] || 'digit').toLowerCase();

const KEYSTROKES: Record<
  string,
  { description: string; bytes: string; expectedLabel: string }
> = {
  digit: {
    description: 'press "2" to pick option 2 (Green)',
    bytes: '2',
    expectedLabel: 'GREEN',
  },
  'digit-enter': {
    description: '"2" then Enter',
    bytes: '2\r',
    expectedLabel: 'GREEN',
  },
  arrow: {
    description: 'one Down arrow then Enter (Red->Green)',
    bytes: '\x1b[B\r',
    expectedLabel: 'GREEN',
  },
  'ss3-arrow': {
    description: 'SS3 Down arrow then Enter',
    bytes: '\x1bOB\r',
    expectedLabel: 'GREEN',
  },
  label: {
    description: 'type "Green" then Enter (search filter)',
    bytes: 'Green\r',
    expectedLabel: 'GREEN',
  },
  'just-enter': {
    description: 'just Enter on default (Red)',
    bytes: '\r',
    expectedLabel: 'RED',
  },
  space: {
    description: 'Space then Enter (toggle pick)',
    bytes: ' \r',
    expectedLabel: 'RED',
  },
};

const choice = KEYSTROKES[VARIANT];
if (!choice) {
  console.error(
    `Unknown variant: ${VARIANT}. Choose from: ${Object.keys(KEYSTROKES).join(', ')}`,
  );
  process.exit(1);
}

const PROMPT = `Use your AskUserQuestion tool to ask me to pick a color from these four labelled options:
  Red, Green, Blue, Yellow

After I answer, reply with EXACTLY this format and nothing else:
  PICKED: <UPPERCASE_LABEL>

Don't add anything else. Don't comment.`;

async function main() {
  console.log(`=== Variant: ${VARIANT} ===`);
  console.log(`Strategy: ${choice.description}`);
  console.log(`Bytes:    ${JSON.stringify(choice.bytes)}`);
  console.log(`Expect:   PICKED: ${choice.expectedLabel}\n`);

  const driver = new ClaudeCLIDriver({
    model: 'sonnet',
    cwd: process.cwd(),
    permissionMode: 'bypassPermissions',
  });

  const controller = new AbortController();
  setTimeout(() => controller.abort(), 90_000);

  const start = Date.now();
  let textOutput = '';

  try {
    for await (const event of driver.sendMessage(PROMPT, controller.signal)) {
      const ms = Date.now() - start;
      const type = (event as { type: string }).type;
      if (type === ProviderEventType.ToolUse) {
        const name = (event as { toolName: string }).toolName;
        console.log(`[+${(ms / 1000).toFixed(1)}s] ToolUse: ${name}`);
        if (name === 'AskUserQuestion') {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const pty = (driver as any).activePty as {
            write(d: string): void;
          } | null;
          if (!pty) {
            console.log('  ! NO activePty');
            continue;
          }
          // Wait LONGER (5s) for picker to fully render
          setTimeout(() => {
            try {
              pty.write(choice.bytes);
              console.log(
                `[+${((Date.now() - start) / 1000).toFixed(1)}s] wrote ${JSON.stringify(choice.bytes)}`,
              );
            } catch (e) {
              console.error('  pty.write threw:', e);
            }
          }, 5000);
        }
      } else if (type === ProviderEventType.ToolResult) {
        const output = (event as { output: string }).output;
        console.log(
          `[+${(ms / 1000).toFixed(1)}s] ToolResult: ${JSON.stringify(output).slice(0, 200)}`,
        );
      } else if (type === ProviderEventType.Content) {
        const text = (event as { text: string }).text;
        textOutput += text;
        console.log(
          `[+${(ms / 1000).toFixed(1)}s] Content: ${JSON.stringify(text.slice(0, 200))}`,
        );
      } else if (type === ProviderEventType.Finished) {
        console.log(`[+${(ms / 1000).toFixed(1)}s] Finished`);
      } else if (type === ProviderEventType.Error) {
        console.log(
          `[+${(ms / 1000).toFixed(1)}s] Error: ${(event as { message: string }).message}`,
        );
      } else {
        console.log(`[+${(ms / 1000).toFixed(1)}s] ${type}`);
      }
    }
  } catch (e) {
    console.error('threw:', e instanceof Error ? e.message : String(e));
  } finally {
    await driver.interrupt();
  }

  console.log(`\n--- Result ---`);
  console.log(`Reply: ${JSON.stringify(textOutput)}`);
  const matched = textOutput
    .toUpperCase()
    .includes(`PICKED: ${choice.expectedLabel}`);
  console.log(
    `Matched expected (${choice.expectedLabel}): ${matched ? '✓ YES' : '✗ NO'}`,
  );
  process.exit(0);
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
