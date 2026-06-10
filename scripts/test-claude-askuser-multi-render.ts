/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 *
 * Probe what the multi-question AskUserQuestion picker looks like in PTY
 * AFTER it has rendered. Write to a log file we can inspect afterwards.
 */

import { writeFileSync } from 'node:fs';
import { ClaudeCLIDriver } from '../packages/core/src/providers/claude/claudeCLIDriver.js';
import { ProviderEventType } from '../packages/core/src/providers/types.js';
import stripAnsi from 'strip-ansi';

const PROMPT = `Use your AskUserQuestion tool with TWO questions in ONE tool call:
Q1: "Color?" — options: Red, Green, Blue
Q2: "Size?"  — options: Small, Medium, Large
Don't reply, just call the tool.`;

async function main() {
  const driver = new ClaudeCLIDriver({
    model: 'sonnet',
    cwd: process.cwd(),
    permissionMode: 'bypassPermissions',
  });

  const controller = new AbortController();
  setTimeout(() => controller.abort(), 30_000);

  for await (const event of driver.sendMessage(PROMPT, controller.signal)) {
    const type = (event as { type: string }).type;
    if (type === ProviderEventType.InteractivePromptStart) {
      // Wait 4s for picker to fully render, then dump PTY output
      await new Promise((r) => setTimeout(r, 4000));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const pty = (driver as any).recentPtyOutput as string;
      const stripped = stripAnsi(pty);
      writeFileSync(
        'C:/Users/thaci/AppData/Local/Temp/multi-picker-render.txt',
        stripped,
      );
      console.log(
        'PTY dumped to multi-picker-render.txt (' + stripped.length + ' chars)',
      );
      controller.abort();
      break;
    }
  }
  await driver.interrupt();
  process.exit(0);
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
