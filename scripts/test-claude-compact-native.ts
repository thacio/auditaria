/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 *
 * Tests provider-native /compress routing.
 *
 * Run with: npx tsx scripts/test-claude-compact-native.ts
 *
 * Sequence:
 *   1. Drive 3 turns via ClaudeCLIDriver to build a real Claude session with
 *      real history. Capture session ID.
 *   2. Build a fake GeminiChat (just enough surface) prepopulated with the
 *      same history mirror.
 *   3. Construct a ProviderManager pointed at claude-cli with the captured
 *      session ID injected via setPendingResumeSessionId.
 *   4. Call providerManager.compactNative(fakeChat, signal).
 *   5. Verify:
 *        - status === COMPRESSED
 *        - chat history was rewritten with <state_snapshot> tags
 *        - originalTokenCount > newTokenCount
 *        - Claude session ID PRESERVED (no reset)
 */

import type { Content } from '@google/genai';
import { ClaudeCLIDriver } from '../packages/core/src/providers/claude/claudeCLIDriver.js';
import { ProviderManager } from '../packages/core/src/providers/providerManager.js';
import { ProviderEventType } from '../packages/core/src/providers/types.js';
import { CompressionStatus } from '../packages/core/src/core/turn.js';
import type { GeminiChat } from '../packages/core/src/core/geminiChat.js';

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
  return {
    chat,
    getRawHistory: () => history,
  };
}

async function driveTurn(
  driver: ClaudeCLIDriver,
  prompt: string,
): Promise<{ text: string; tools: string[] }> {
  const text: string[] = [];
  const tools: string[] = [];
  const start = Date.now();
  for await (const event of driver.sendMessage(
    prompt,
    new AbortController().signal,
  )) {
    if (event.type === ProviderEventType.Content) {
      text.push(event.text);
    } else if (event.type === ProviderEventType.ToolUse) {
      tools.push(event.toolName);
    } else if (event.type === ProviderEventType.Error) {
      throw new Error(`Driver error: ${event.message}`);
    }
  }
  console.log(
    `    (${((Date.now() - start) / 1000).toFixed(1)}s, ` +
      `${text.join('').length} chars text, ${tools.length} tools)`,
  );
  return { text: text.join(''), tools };
}

async function main() {
  console.log('=== Provider-native /compress routing test ===\n');

  // ─── Phase 1: build a real Claude session ─────────────────────────────────
  console.log('Phase 1: drive 3 turns to build a real Claude session');
  const driver = new ClaudeCLIDriver({
    model: 'haiku',
    cwd: process.cwd(),
    permissionMode: 'bypassPermissions',
  });

  // Substantive turns so Claude has enough context to actually compact.
  // (Tiny ALPHA/BRAVO turns don't trigger compaction — Claude exits cleanly
  // with nothing to do and PostCompact never fires.)
  const turn1 = await driveTurn(
    driver,
    'Use your Read tool to read C:/projects/auditaria/scripts/test-claude-interactive.ts in full. Then in two sentences describe what the test verifies. The secret word for this run is "ECHO-COMPACT-TEST" — remember it.',
  );
  console.log(
    '  Turn 1 reply (first 200 chars):',
    JSON.stringify(turn1.text.slice(0, 200)),
  );

  const turn2 = await driveTurn(
    driver,
    'Now use your Read tool to read C:/projects/auditaria/packages/core/src/providers/claude/claudeCLIDriver.ts. Then list, in one sentence each, three concrete things this driver does that the legacy print-mode driver did not.',
  );
  console.log(
    '  Turn 2 reply (first 200 chars):',
    JSON.stringify(turn2.text.slice(0, 200)),
  );

  const turn3 = await driveTurn(
    driver,
    'Now reply with exactly the word CHARLIE. Nothing else.',
  );
  console.log('  Turn 3 reply:', JSON.stringify(turn3.text));

  const sessionIdBefore = driver.getSessionId();
  console.log('  Session ID after 3 turns:', sessionIdBefore);
  driver.dispose();

  if (!sessionIdBefore) {
    console.error('[FAIL] Could not capture session ID after warm-up turns');
    process.exit(1);
  }

  // ─── Phase 2: build a fake chat mirror ────────────────────────────────────
  // We don't need this to be 100% accurate — compactMirroredHistory just
  // needs enough length to trim. Mirror the 6 messages (3 user + 3 model).
  const mockHistory: Content[] = [
    {
      role: 'user',
      parts: [{ text: 'Reply with exactly the word ALPHA. Nothing else.' }],
    },
    { role: 'model', parts: [{ text: turn1.text }] },
    {
      role: 'user',
      parts: [{ text: 'Now reply with exactly the word BRAVO. Nothing else.' }],
    },
    { role: 'model', parts: [{ text: turn2.text }] },
    {
      role: 'user',
      parts: [
        { text: 'Now reply with exactly the word CHARLIE. Nothing else.' },
      ],
    },
    { role: 'model', parts: [{ text: turn3.text }] },
    // Add a bit of bulk so we have something meaningful to compact.
    { role: 'user', parts: [{ text: 'A'.repeat(2000) }] },
    { role: 'model', parts: [{ text: 'B'.repeat(2000) }] },
    { role: 'user', parts: [{ text: 'C'.repeat(2000) }] },
    { role: 'model', parts: [{ text: 'D'.repeat(2000) }] },
  ];

  console.log(
    '\nPhase 2: built fake chat mirror with',
    mockHistory.length,
    'messages',
  );
  const { chat: fakeChat, getRawHistory } = buildMockChat(mockHistory);

  // ─── Phase 3: construct ProviderManager pointed at claude-cli ────────────
  console.log('\nPhase 3: construct ProviderManager + inject session ID');
  const pm = new ProviderManager(
    { type: 'claude-cli', model: 'haiku', cwd: process.cwd() },
    process.cwd(),
  );

  console.log('  supportsNativeCompact:', pm.supportsNativeCompact());
  if (!pm.supportsNativeCompact()) {
    console.error('[FAIL] supportsNativeCompact returned false for claude-cli');
    process.exit(2);
  }

  pm.setPendingResumeSessionId(sessionIdBefore);
  console.log('  Pending resume session ID set:', sessionIdBefore);

  // ─── Phase 4: call compactNative ──────────────────────────────────────────
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
  console.log(
    '  Has <state_snapshot> tag:',
    finalHistory.some((c) =>
      c.parts?.some((p) => 'text' in p && p.text?.includes('<state_snapshot>')),
    ),
  );

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
      `  ✗ session ID CHANGED (would mean fresh Claude spawn): ${sessionIdBefore} → ${sessionIdAfter}`,
    );
    allPass = false;
  } else {
    console.log('  ✓ session ID preserved (Claude session continues)');
  }
  if (
    !finalHistory.some((c) =>
      c.parts?.some((p) => 'text' in p && p.text?.includes('<state_snapshot>')),
    )
  ) {
    console.error('  ✗ mock history lacks <state_snapshot> tag');
    allPass = false;
  } else {
    console.log('  ✓ mock history rewritten with <state_snapshot> tag');
  }

  pm.dispose();

  if (allPass) {
    console.log('\n✓✓✓ PASS — provider-native /compress routing works.');
    process.exit(0);
  }
  console.error('\n✗ FAIL — see assertions above.');
  process.exit(3);
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
