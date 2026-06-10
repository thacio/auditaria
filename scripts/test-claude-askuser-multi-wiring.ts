/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 *
 * Multi-question AskUserQuestion wiring test: 2 questions in one tool call,
 * we pick one option per question, expect Claude to report both picks.
 */

import { ClaudeCLIDriver } from '../packages/core/src/providers/claude/claudeCLIDriver.js';
import {
  ProviderEventType,
  type InteractivePromptStartEvent,
} from '../packages/core/src/providers/types.js';

const PROMPT = `Use your AskUserQuestion tool with TWO questions in ONE
tool call:
Q1: "Pick a color" — options: Red, Green, Blue
Q2: "Pick a size"  — options: Small, Medium, Large

After I answer both, reply with EXACTLY one line in this format:
  RESULT color=<UPPER> size=<UPPER>

Nothing else. Don't comment.`;

const EXPECT_COLOR = 'Blue'; // option index 2
const EXPECT_SIZE = 'Medium'; // option index 1

async function main() {
  console.log('=== Multi-question AskUserQuestion wiring test ===');
  console.log(`Expect: color=${EXPECT_COLOR} size=${EXPECT_SIZE}\n`);

  const driver = new ClaudeCLIDriver({
    model: 'sonnet',
    cwd: process.cwd(),
    permissionMode: 'bypassPermissions',
  });

  const controller = new AbortController();
  setTimeout(() => controller.abort(), 120_000);

  const start = Date.now();
  let promptStart: InteractivePromptStartEvent | null = null;
  let promptResolved = false;
  let textOutput = '';

  try {
    for await (const event of driver.sendMessage(PROMPT, controller.signal)) {
      const ms = Date.now() - start;
      const ts = `[+${(ms / 1000).toFixed(1)}s]`;
      const type = (event as { type: string }).type;
      if (type === ProviderEventType.ToolUse) {
        console.log(
          `${ts} ToolUse: ${(event as { toolName: string }).toolName}`,
        );
      } else if (type === ProviderEventType.InteractivePromptStart) {
        promptStart = event as InteractivePromptStartEvent;
        console.log(
          `${ts} InteractivePromptStart: ${promptStart.questions.length} questions`,
        );
        // Build answers for both Q's.
        const answers = promptStart.questions.map((q) => {
          const wantedLabel = q.options.find((o) =>
            [EXPECT_COLOR, EXPECT_SIZE].includes(o.label),
          );
          if (!wantedLabel) {
            throw new Error(`No matching option in Q "${q.question}"`);
          }
          return { questionId: q.id, optionIds: [wantedLabel.id] };
        });
        console.log(
          `     answering: ${answers.map((a, i) => `Q${i + 1}=${a.optionIds[0]}`).join(' ')}`,
        );
        await driver.respondToPrompt(promptStart.promptId, {
          kind: 'answered',
          answers,
        });
      } else if (type === ProviderEventType.InteractivePromptResolved) {
        promptResolved = true;
        console.log(`${ts} InteractivePromptResolved`);
      } else if (type === ProviderEventType.ToolResult) {
        console.log(
          `${ts} ToolResult: ${JSON.stringify((event as { output: string }).output).slice(0, 200)}`,
        );
      } else if (type === ProviderEventType.Content) {
        const text = (event as { text: string }).text;
        textOutput += text;
        console.log(`${ts} Content: ${JSON.stringify(text.slice(0, 200))}`);
      } else if (type === ProviderEventType.Finished) {
        console.log(`${ts} Finished`);
      } else if (type === ProviderEventType.Error) {
        console.log(`${ts} Error: ${(event as { message: string }).message}`);
      } else {
        console.log(`${ts} ${type}`);
      }
    }
  } finally {
    driver.dispose();
  }

  console.log('\n────── Assertions ──────');
  let pass = true;
  const a = (cond: boolean, msg: string) => {
    console.log(cond ? `  ✓ ${msg}` : `  ✗ ${msg}`);
    if (!cond) pass = false;
  };
  a(promptStart !== null, 'InteractivePromptStart fired');
  a(promptStart?.questions.length === 2, '2 questions in event');
  a(promptResolved, 'InteractivePromptResolved fired');
  a(
    textOutput.toUpperCase().includes(`COLOR=${EXPECT_COLOR.toUpperCase()}`),
    `reply has color=${EXPECT_COLOR.toUpperCase()}`,
  );
  a(
    textOutput.toUpperCase().includes(`SIZE=${EXPECT_SIZE.toUpperCase()}`),
    `reply has size=${EXPECT_SIZE.toUpperCase()}`,
  );

  console.log(pass ? '\n✓✓✓ PASS' : '\n✗ FAIL');
  process.exit(pass ? 0 : 3);
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
