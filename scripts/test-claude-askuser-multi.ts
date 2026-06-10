/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 *
 * Probe Claude's multi-question AskUserQuestion behavior. Does Claude
 * actually emit multiple questions in one tool call? What does the picker
 * look like in PTY? What keystrokes navigate between them?
 */

import { ClaudeCLIDriver } from '../packages/core/src/providers/claude/claudeCLIDriver.js';
import {
  ProviderEventType,
  type InteractivePromptStartEvent,
} from '../packages/core/src/providers/types.js';

const PROMPT = `Use your AskUserQuestion tool with TWO questions in ONE
tool call (single tool call with questions: [Q1, Q2]):

Q1: "What's your favorite color?" — options: Red, Green, Blue
Q2: "What's your favorite size?" — options: Small, Medium, Large

After I answer both, reply with EXACTLY this format and nothing else:
  COLOR=<choice>  SIZE=<choice>`;

async function main() {
  console.log('=== Multi-question AskUserQuestion probe ===\n');

  const driver = new ClaudeCLIDriver({
    model: 'sonnet',
    cwd: process.cwd(),
    permissionMode: 'bypassPermissions',
  });

  const controller = new AbortController();
  setTimeout(() => controller.abort(), 90_000);

  const start = Date.now();
  let promptStart: InteractivePromptStartEvent | null = null;

  try {
    for await (const event of driver.sendMessage(PROMPT, controller.signal)) {
      const ms = Date.now() - start;
      const ts = `[+${(ms / 1000).toFixed(1)}s]`;
      const type = (event as { type: string }).type;
      if (type === ProviderEventType.InteractivePromptStart) {
        promptStart = event as InteractivePromptStartEvent;
        console.log(`${ts} InteractivePromptStart:`);
        console.log(`  questions count: ${promptStart.questions.length}`);
        for (let i = 0; i < promptStart.questions.length; i++) {
          const q = promptStart.questions[i];
          console.log(`  Q${i + 1}: "${q.question}"`);
          console.log(
            `     options: ${q.options.map((o) => o.label).join(', ')}`,
          );
          console.log(`     multiSelect: ${q.multiSelect}`);
        }
        // Do NOT respond — let it hang so we can see PTY output
        console.log(`  (NOT responding — watching what picker renders)`);
      } else if (type === ProviderEventType.ToolUse) {
        console.log(
          `${ts} ToolUse: ${(event as { toolName: string }).toolName}`,
        );
      } else if (type === ProviderEventType.Content) {
        console.log(
          `${ts} Content: ${JSON.stringify((event as { text: string }).text.slice(0, 200))}`,
        );
      } else if (type === ProviderEventType.Error) {
        console.log(`${ts} Error: ${(event as { message: string }).message}`);
      } else {
        console.log(`${ts} ${type}`);
      }
    }
  } catch (e) {
    console.error('threw:', e instanceof Error ? e.message : String(e));
  } finally {
    await driver.interrupt();
  }

  console.log('\nDone.');
  process.exit(0);
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
