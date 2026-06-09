/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 *
 * End-to-end wiring test for Phase 1 AskUserQuestion surfacing.
 *
 * Does NOT use Ink/UI. Drives the ClaudeCLIDriver directly:
 *   1. Send a prompt that triggers AskUserQuestion (4 colors).
 *   2. Listen for InteractivePromptStart event.
 *   3. Programmatically call driver.respondToPrompt with the user's pick.
 *   4. Expect ToolResult + InteractivePromptResolved + Content events.
 *   5. Assert Claude received the answer.
 */

import { ClaudeCLIDriver } from '../packages/core/src/providers/claude/claudeCLIDriver.js';
import {
  ProviderEventType,
  type InteractivePromptStartEvent,
} from '../packages/core/src/providers/types.js';

const PROMPT = `Use your AskUserQuestion tool to ask me to pick a color from
exactly these four options labelled in this exact order:
  Red, Green, Blue, Yellow

After I answer, reply with EXACTLY this single-line format and nothing else:
  PICKED: <UPPERCASE_LABEL>`;

const EXPECTED_PICK = 'Blue'; // we'll programmatically pick option 3

async function main() {
  console.log('=== AskUserQuestion wiring test ===\n');
  console.log('Expected pick: Blue (option 3)\n');

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
        const name = (event as { toolName: string }).toolName;
        console.log(`${ts} ToolUse: ${name}`);
      } else if (type === ProviderEventType.InteractivePromptStart) {
        promptStart = event as InteractivePromptStartEvent;
        console.log(`${ts} ✓ InteractivePromptStart fired`);
        console.log(`     promptId: ${promptStart.promptId}`);
        console.log(`     kind: ${promptStart.kind}`);
        console.log(`     title: ${promptStart.title}`);
        console.log(`     questions: ${promptStart.questions.length}`);
        for (const q of promptStart.questions) {
          console.log(
            `       Q "${q.question}" — ${q.options.length} options: ${q.options.map((o) => o.label).join(', ')}`,
          );
        }
        // Programmatically pick Blue (option index 2, 1-indexed = 3)
        const q = promptStart.questions[0];
        const bluOpt = q.options.find((o) => o.label === EXPECTED_PICK);
        if (!bluOpt) {
          console.error(`Could not find option "${EXPECTED_PICK}" in picker`);
          process.exit(2);
        }
        console.log(
          `     → calling respondToPrompt with option "${bluOpt.label}"`,
        );
        await driver.respondToPrompt(promptStart.promptId, {
          kind: 'answered',
          answers: [{ questionId: q.id, optionIds: [bluOpt.id] }],
        });
      } else if (type === ProviderEventType.InteractivePromptResolved) {
        promptResolved = true;
        console.log(`${ts} ✓ InteractivePromptResolved fired`);
      } else if (type === ProviderEventType.ToolResult) {
        const out = (event as { output: string }).output;
        console.log(`${ts} ToolResult: ${JSON.stringify(out).slice(0, 200)}`);
      } else if (type === ProviderEventType.Content) {
        const text = (event as { text: string }).text;
        textOutput += text;
        console.log(`${ts} Content: ${JSON.stringify(text.slice(0, 200))}`);
      } else if (type === ProviderEventType.Finished) {
        console.log(`${ts} Finished`);
      } else if (type === ProviderEventType.Error) {
        const msg = (event as { message: string }).message;
        console.log(`${ts} Error: ${msg}`);
      } else {
        console.log(`${ts} ${type}`);
      }
    }
  } catch (e) {
    console.error('threw:', e instanceof Error ? e.message : String(e));
  } finally {
    driver.dispose();
  }

  console.log('\n──────────── Assertions ────────────');
  let pass = true;
  const a = (cond: boolean, msg: string) => {
    if (cond) {
      console.log(`  ✓ ${msg}`);
    } else {
      console.log(`  ✗ ${msg}`);
      pass = false;
    }
  };

  a(promptStart !== null, 'InteractivePromptStart was emitted by driver');
  a(promptResolved, 'InteractivePromptResolved was emitted after PostToolUse');
  a(promptStart?.questions[0]?.options.length === 4, 'Picker had 4 options');
  a(
    promptStart?.toolName === 'AskUserQuestion',
    'Event was tagged toolName=AskUserQuestion',
  );
  // Claude 2.1.169+ transcript-writing regression is worked around by the
  // PTY-scrape fallback in claudeCLIDriver.scrapeAssistantTextFromPTY().
  // We assert on textOutput as if the transcript worked — the scraper
  // makes Content events available either way.
  a(
    textOutput.toUpperCase().includes(`PICKED: ${EXPECTED_PICK.toUpperCase()}`),
    `Claude responded with PICKED: ${EXPECTED_PICK.toUpperCase()} (via PTY-scrape fallback)`,
  );

  if (pass) {
    console.log('\n✓✓✓ PASS — AskUserQuestion wiring works end-to-end');
    process.exit(0);
  } else {
    console.log('\n✗ FAIL — see assertions above');
    process.exit(3);
  }
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
