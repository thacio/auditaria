/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 *
 * Self-test for the new interactive Claude driver.
 *
 * Run with: npx tsx scripts/test-claude-interactive.ts
 * Optional:  $env:AUDITARIA_PROVIDER_DEBUG=1; npx tsx scripts/test-claude-interactive.ts
 *
 * What it verifies:
 *   1. The driver spawns `claude` via PTY without -p.
 *   2. SessionStart + Stop hooks fire end-to-end.
 *   3. We can read the transcript and yield ProviderEvents.
 *   4. The resulting Claude session is tagged `entrypoint:"cli"` (interactive
 *      billing) rather than `"sdk-cli"` (SDK billing) — the whole point of
 *      this rewrite.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ClaudeCLIDriver } from '../packages/core/src/providers/claude/claudeCLIDriver.js';
import { ProviderEventType } from '../packages/core/src/providers/types.js';

const PROMPT_1 =
  'Reply with exactly the single word PONG (uppercase, no punctuation, ' +
  'no other text). This is an automated smoke test.';

const PROMPT_2 =
  'What word did you just reply with? Answer in exactly one word, ' +
  'uppercase, no punctuation.';

function encodeProjectPath(absPath: string): string {
  return absPath.replace(/[:\\/]/g, '-');
}

async function main() {
  console.log('=== Interactive Claude Driver — self-test ===\n');
  console.log('cwd:', process.cwd());
  console.log('platform:', process.platform);
  console.log('node:', process.version);
  console.log('');

  const driver = new ClaudeCLIDriver({
    model: 'haiku', // cheapest tier for smoke test
    cwd: process.cwd(),
    permissionMode: 'bypassPermissions',
  });

  const controller = new AbortController();

  async function runTurn(label: string, prompt: string): Promise<string> {
    console.log(`\n--- ${label} ---`);
    console.log('Prompt:', JSON.stringify(prompt));
    console.log('Sending...');
    const start = Date.now();
    let text = '';
    const watchdog = setTimeout(() => {
      console.error('[WATCHDOG] aborting after 90s');
      controller.abort();
    }, 90_000);
    try {
      for await (const event of driver.sendMessage(prompt, controller.signal)) {
        const ms = Date.now() - start;
        const type = (event as { type: string }).type;
        if (type === ProviderEventType.Content) {
          const t = (event as { text: string }).text;
          text += t;
          console.log(`  [+${ms}ms] Content (${t.length} chars)`);
        } else if (type === ProviderEventType.ModelInfo) {
          console.log(
            `  [+${ms}ms] ModelInfo: ${(event as { model: string }).model}`,
          );
        } else if (type === ProviderEventType.Finished) {
          console.log(
            `  [+${ms}ms] Finished. usage=${JSON.stringify((event as { usage?: unknown }).usage)}`,
          );
        } else if (type === ProviderEventType.Error) {
          console.log(
            `  [+${ms}ms] ERROR: ${(event as { message: string }).message}`,
          );
        } else {
          console.log(`  [+${ms}ms] ${type}`);
        }
      }
    } finally {
      clearTimeout(watchdog);
    }
    console.log(`  Reply text: ${JSON.stringify(text)}`);
    console.log(`  Session ID after turn: ${driver.getSessionId()}`);
    return text;
  }

  const reply1 = await runTurn('TURN 1 (fresh session)', PROMPT_1);
  const sessionAfter1 = driver.getSessionId();
  const reply2 = await runTurn('TURN 2 (resume)', PROMPT_2);
  const sessionAfter2 = driver.getSessionId();

  console.log('\n--- Multi-turn summary ---');
  console.log('Session after turn 1:', sessionAfter1);
  console.log('Session after turn 2:', sessionAfter2);
  console.log('Reply 1:', JSON.stringify(reply1));
  console.log('Reply 2:', JSON.stringify(reply2));

  if (sessionAfter1 && sessionAfter1 === sessionAfter2) {
    console.log('✓ Session ID persisted across turns (resume worked).');
  } else {
    console.error('✗ Session ID changed — resume did NOT work.');
  }
  const textOutput = reply1;

  // ─── verify interactive billing ────────────────────────────────────────────
  const sessionId = driver.getSessionId();
  if (!sessionId) {
    console.error(
      '\n[FAIL] No session ID captured. Cannot verify billing classification.',
    );
    driver.dispose();
    process.exit(3);
  }

  const transcriptPath = join(
    homedir(),
    '.claude',
    'projects',
    encodeProjectPath(process.cwd()),
    `${sessionId}.jsonl`,
  );
  console.log('Transcript:', transcriptPath);

  let transcript: string;
  try {
    transcript = readFileSync(transcriptPath, 'utf-8');
  } catch (e) {
    console.error('[FAIL] Could not read transcript:', e);
    driver.dispose();
    process.exit(3);
  }

  const lines = transcript
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

  console.log('Transcript lines:', lines.length);

  const userMsgs = lines.filter((l) => l['type'] === 'user');
  const lastUser = userMsgs[userMsgs.length - 1];
  if (!lastUser) {
    console.error('[FAIL] No user message found in transcript.');
    driver.dispose();
    process.exit(3);
  }

  const entrypoint = lastUser['entrypoint'];
  console.log('Last user message entrypoint:', JSON.stringify(entrypoint));

  driver.dispose();

  if (entrypoint === 'cli') {
    console.log('\n✓✓✓ PASS — entrypoint is "cli" → INTERACTIVE billing.');
    if (textOutput.toUpperCase().includes('PONG')) {
      console.log('✓ Response contains "PONG" — driver round-trip works.');
    } else {
      console.log(
        '⚠ Response did not contain "PONG" — model went off-script but driver worked.',
      );
    }
    process.exit(0);
  } else if (entrypoint === 'sdk-cli') {
    console.error(
      '\n✗✗✗ FAIL — entrypoint is "sdk-cli" → SDK billing. ' +
        'Something in the spawn is still triggering the non-interactive path.',
    );
    process.exit(4);
  } else {
    console.error(
      `\n? UNKNOWN entrypoint "${String(entrypoint)}" — investigate.`,
    );
    process.exit(5);
  }
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
