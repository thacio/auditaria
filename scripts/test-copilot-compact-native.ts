/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 *
 * Tests provider-native /compress routing for Copilot.
 *
 * Run with: npx tsx scripts/test-copilot-compact-native.ts
 *
 * Uses GPT-5 mini (0x usage) so this doesn't burn quota.
 *
 * Sequence:
 *   1. Drive 3 substantive turns via CopilotCLIDriver to build a real session.
 *   2. Mirror those turns into a fake GeminiChat.
 *   3. Construct ProviderManager pointed at copilot-cli, inject session ID.
 *   4. Call providerManager.compactNative(fakeChat, signal).
 *   5. Verify:
 *        - status === COMPRESSED (synthetic Compacted event fired)
 *        - chat history rewritten with <state_snapshot> or <context_compacted> tag
 *        - originalTokenCount > newTokenCount
 *        - session ID preserved (no fresh spawn)
 */

import type { Content } from '@google/genai';
import { CopilotCLIDriver } from '../packages/core/src/providers/copilot/copilotCLIDriver.js';
import { ProviderManager } from '../packages/core/src/providers/providerManager.js';
import { ProviderEventType } from '../packages/core/src/providers/types.js';
import { CompressionStatus } from '../packages/core/src/core/turn.js';
import type { GeminiChat } from '../packages/core/src/core/geminiChat.js';

const MODEL = 'gpt-5-mini'; // 0x usage — free to test against

function buildMockChat(initialHistory: Content[]) {
  let history = [...initialHistory];
  const chat = {
    getHistory(): Content[] {
      return [...history];
    },
    setHistory(newHistory: readonly Content[]) {
      history = [...newHistory];
    },
  } as unknown as GeminiChat;
  return { chat, getRawHistory: () => history };
}

async function driveTurn(
  driver: CopilotCLIDriver,
  prompt: string,
): Promise<{ text: string; tools: string[] }> {
  const textParts: string[] = [];
  const tools: string[] = [];
  const start = Date.now();
  for await (const event of driver.sendMessage(
    prompt,
    new AbortController().signal,
  )) {
    if (event.type === ProviderEventType.Content) {
      textParts.push(event.text);
    } else if (event.type === ProviderEventType.ToolUse) {
      tools.push(event.toolName);
    } else if (event.type === ProviderEventType.Error) {
      throw new Error(`Driver error: ${event.message}`);
    }
  }
  console.log(
    `    (${((Date.now() - start) / 1000).toFixed(1)}s, ` +
      `${textParts.join('').length} chars, ${tools.length} tools)`,
  );
  return { text: textParts.join(''), tools };
}

async function main() {
  console.log('=== Copilot native /compact routing test ===');
  console.log(`Model: ${MODEL} (0x usage, no quota burn)\n`);

  // ─── Phase 1: build a real Copilot session ────────────────────────────────
  console.log('Phase 1: drive 3 turns to build a real Copilot session');
  const driver = new CopilotCLIDriver({
    model: MODEL,
    cwd: process.cwd(),
  });

  const turn1 = await driveTurn(
    driver,
    'Reply with exactly the single word ALPHA. Nothing else.',
  );
  console.log('  Turn 1 reply:', JSON.stringify(turn1.text.slice(0, 200)));

  const turn2 = await driveTurn(
    driver,
    'Reply with exactly the single word BRAVO. Nothing else.',
  );
  console.log('  Turn 2 reply:', JSON.stringify(turn2.text.slice(0, 200)));

  const turn3 = await driveTurn(
    driver,
    'Reply with exactly the single word CHARLIE. Nothing else.',
  );
  console.log('  Turn 3 reply:', JSON.stringify(turn3.text.slice(0, 200)));

  const sessionIdBefore = driver.getSessionId();
  console.log('  Session ID after 3 turns:', sessionIdBefore);
  driver.dispose();

  if (!sessionIdBefore) {
    console.error('[FAIL] Could not capture session ID after warm-up turns');
    process.exit(1);
  }

  // ─── Phase 2: build a fake chat mirror ────────────────────────────────────
  // Add bulk so compactMirroredHistory has something to trim.
  const mockHistory: Content[] = [
    { role: 'user', parts: [{ text: 'Reply with exactly the single word ALPHA. Nothing else.' }] },
    { role: 'model', parts: [{ text: turn1.text }] },
    { role: 'user', parts: [{ text: 'Reply with exactly the single word BRAVO. Nothing else.' }] },
    { role: 'model', parts: [{ text: turn2.text }] },
    { role: 'user', parts: [{ text: 'Reply with exactly the single word CHARLIE. Nothing else.' }] },
    { role: 'model', parts: [{ text: turn3.text }] },
    { role: 'user', parts: [{ text: 'A'.repeat(2000) }] },
    { role: 'model', parts: [{ text: 'B'.repeat(2000) }] },
    { role: 'user', parts: [{ text: 'C'.repeat(2000) }] },
    { role: 'model', parts: [{ text: 'D'.repeat(2000) }] },
  ];
  console.log('\nPhase 2: built fake chat mirror with', mockHistory.length, 'messages');
  const { chat: fakeChat, getRawHistory } = buildMockChat(mockHistory);

  // ─── Phase 3: ProviderManager + resume ────────────────────────────────────
  console.log('\nPhase 3: construct ProviderManager + inject session ID');
  const pm = new ProviderManager(
    { type: 'copilot-cli', model: MODEL, cwd: process.cwd() },
    process.cwd(),
  );

  console.log('  supportsNativeCompact:', pm.supportsNativeCompact());
  if (!pm.supportsNativeCompact()) {
    console.error('[FAIL] supportsNativeCompact returned false for copilot-cli');
    process.exit(2);
  }

  pm.setPendingResumeSessionId(sessionIdBefore);
  console.log('  Pending resume session ID set:', sessionIdBefore);

  // ─── Phase 4: compactNative ───────────────────────────────────────────────
  console.log('\nPhase 4: calling compactNative()');
  const start = Date.now();
  const result = await pm.compactNative(fakeChat, new AbortController().signal);
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`  Returned in ${elapsed}s`);
  console.log('  result:', result);
  console.log('  status enum:', CompressionStatus[result.status]);

  // ─── Phase 5: verify ──────────────────────────────────────────────────────
  console.log('\nPhase 5: verification');

  const sessionIdAfter = pm.getDriverSessionId();
  console.log('  Session ID before compact:', sessionIdBefore);
  console.log('  Session ID after compact: ', sessionIdAfter);

  const finalHistory = getRawHistory();
  console.log('  Mock history length: before=10, after=', finalHistory.length);

  const hasStateSnapshot = finalHistory.some((c) =>
    c.parts?.some(
      (p) => 'text' in p && p.text?.includes('<state_snapshot>'),
    ),
  );
  const hasContextCompacted = finalHistory.some((c) =>
    c.parts?.some(
      (p) => 'text' in p && p.text?.includes('<context_compacted>'),
    ),
  );
  console.log('  Has <state_snapshot> tag (Copilot streamed a summary):', hasStateSnapshot);
  console.log('  Has <context_compacted> tag (no summary, generic):    ', hasContextCompacted);

  let allPass = true;
  if (result.status !== CompressionStatus.COMPRESSED) {
    console.error('  ✗ status != COMPRESSED');
    allPass = false;
  } else {
    console.log('  ✓ status === COMPRESSED');
  }
  if (result.newTokenCount >= result.originalTokenCount) {
    console.error(
      `  ✗ token count did not shrink: ${result.originalTokenCount} → ${result.newTokenCount}`,
    );
    allPass = false;
  } else {
    console.log(
      `  ✓ token count shrunk: ${result.originalTokenCount} → ${result.newTokenCount}`,
    );
  }
  if (sessionIdAfter !== sessionIdBefore) {
    console.error(
      `  ✗ session ID CHANGED (would mean fresh Copilot spawn): ${sessionIdBefore} → ${sessionIdAfter}`,
    );
    allPass = false;
  } else {
    console.log('  ✓ session ID preserved (Copilot session continues)');
  }
  if (!hasStateSnapshot && !hasContextCompacted) {
    console.error('  ✗ mock history lacks compaction envelope tag');
    allPass = false;
  } else {
    console.log('  ✓ mock history rewritten with compaction envelope');
  }

  pm.dispose();

  if (allPass) {
    console.log('\n✓✓✓ PASS — Copilot native /compact routing works.');
    process.exit(0);
  }
  console.error('\n✗ FAIL — see assertions above.');
  process.exit(3);
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
