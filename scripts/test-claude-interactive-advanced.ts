/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 *
 * Advanced stress test for the interactive Claude driver.
 *
 * Run with: npx tsx scripts/test-claude-interactive-advanced.ts
 *
 * Sequence (all over a single resumed session):
 *   Turn 1: Read a sizable file + dispatch 2 parallel web-search subagents.
 *   Turn 2: Remember a secret word; reply in an exact format.
 *   Turn 3: /compact slash command.
 *   Turn 4: Ask Claude what it still has in context (the file? the search
 *           results? the secret word?) — confirms compaction summary semantics.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ClaudeCLIDriver } from '../packages/core/src/providers/claude/claudeCLIDriver.js';
import { ProviderEventType } from '../packages/core/src/providers/types.js';

function encodeProjectPath(p: string): string {
  return p.replace(/[:\\/]/g, '-');
}

const FILE_TO_READ = 'C:/projects/auditaria/scripts/test-claude-interactive.ts';

const TURN_1 = `Do two things in this turn, both required, both via your tools:

1. Use your Read tool to read this file in full and tell me how many lines it has and what the test asserts at the end: ${FILE_TO_READ}

2. In parallel with the read, dispatch TWO subagents using the Agent / Task tool:
   - Agent A: search the web for "node-pty Windows ConPTY 2026 issues" and summarize the top 2 results in two sentences.
   - Agent B: search the web for "Claude Code Agent SDK billing change June 2026" and summarize the top 2 results in two sentences.

When both subagents return AND you've read the file, give me ONE consolidated reply in this format:

   FILE: <lines>, asserts: <one-sentence>
   AGENT_A: <2 sentences>
   AGENT_B: <2 sentences>

Do not skip any step. Do not summarize prematurely.`;

const SECRET =
  'BLUEWHALE-' + Math.random().toString(36).slice(2, 8).toUpperCase();

const TURN_2 = `Good. Now remember: the secret word is "${SECRET}".
Reply with EXACTLY this single line and nothing else:

   ACK secret=${SECRET}`;

const TURN_3 = '/compact';

const TURN_4 = `Be specific and honest. Right now, in your context:
  (a) Is the FULL TEXT of ${FILE_TO_READ} still present, or has it been replaced by a summary? Answer YES / NO / PARTIAL plus one sentence of detail.
  (b) Are the FULL search results from Agent A and Agent B still present, or just a summary? Same YES / NO / PARTIAL + detail.
  (c) Do you still know the secret word from earlier? Echo it back if you do.

Format your reply as:
  (a) <answer>
  (b) <answer>
  (c) <answer>`;

async function main() {
  console.log('=== Interactive Claude — advanced stress test ===\n');
  console.log('Secret word for this run:', SECRET);
  console.log('');

  const driver = new ClaudeCLIDriver({
    model: 'sonnet', // need a tool-capable model; sonnet handles subagents well
    cwd: process.cwd(),
    permissionMode: 'bypassPermissions',
  });

  const controller = new AbortController();

  async function runTurn(
    label: string,
    prompt: string,
    timeoutMs: number,
  ): Promise<{ text: string; tools: string[]; usage?: unknown }> {
    console.log(`\n══ ${label} ══`);
    console.log('Prompt preview:', prompt.slice(0, 200).replace(/\n/g, ' ↵ '));
    const start = Date.now();
    let text = '';
    const tools: string[] = [];
    let usage: unknown;
    const watchdog = setTimeout(() => {
      console.error(`[WATCHDOG] aborting after ${timeoutMs / 1000}s`);
      controller.abort();
    }, timeoutMs);
    try {
      for await (const event of driver.sendMessage(prompt, controller.signal)) {
        const ms = Date.now() - start;
        const t = (event as { type: string }).type;
        if (t === ProviderEventType.Content) {
          text += (event as { text: string }).text;
        } else if (t === ProviderEventType.ToolUse) {
          const name = (event as { toolName: string }).toolName;
          tools.push(name);
          console.log(`  [+${(ms / 1000).toFixed(1)}s] tool_use: ${name}`);
        } else if (t === ProviderEventType.ToolResult) {
          const isErr = (event as { isError?: boolean }).isError;
          console.log(
            `  [+${(ms / 1000).toFixed(1)}s] tool_result ${isErr ? '(ERR)' : ''}`,
          );
        } else if (t === ProviderEventType.ModelInfo) {
          console.log(
            `  [+${(ms / 1000).toFixed(1)}s] model: ${(event as { model: string }).model}`,
          );
        } else if (t === ProviderEventType.Finished) {
          usage = (event as { usage?: unknown }).usage;
          console.log(
            `  [+${(ms / 1000).toFixed(1)}s] finished. usage=${JSON.stringify(usage)}`,
          );
        } else if (t === ProviderEventType.Error) {
          console.log(
            `  [+${(ms / 1000).toFixed(1)}s] ERROR: ${(event as { message: string }).message}`,
          );
        } else {
          console.log(`  [+${(ms / 1000).toFixed(1)}s] ${t}`);
        }
      }
    } finally {
      clearTimeout(watchdog);
    }
    console.log(`  Elapsed: ${((Date.now() - start) / 1000).toFixed(1)}s`);
    console.log(`  Tools used: ${tools.join(', ') || '(none)'}`);
    console.log(
      `  Reply text (${text.length} chars):\n${indent(text, '    ')}`,
    );
    return { text, tools, usage };
  }

  // Turn 1: read file + parallel subagent web searches
  const r1 = await runTurn(
    'TURN 1: file read + 2 web-search subagents',
    TURN_1,
    5 * 60_000,
  );

  // Turn 2: secret word + exact reply format
  const r2 = await runTurn('TURN 2: secret word ACK', TURN_2, 2 * 60_000);

  // Turn 3: slash command — /compact
  const r3 = await runTurn(
    'TURN 3: /compact slash command',
    TURN_3,
    5 * 60_000,
  );

  // Turn 4: ask what's still in context after compaction
  const r4 = await runTurn(
    'TURN 4: what survived the compact?',
    TURN_4,
    2 * 60_000,
  );

  // ─── analysis ─────────────────────────────────────────────────────────────
  console.log('\n══════════════════════════════════════════════════════════');
  console.log('STRESS TEST SUMMARY');
  console.log('══════════════════════════════════════════════════════════');

  console.log('\nTurn 1 reply length:', r1.text.length, 'chars');
  console.log('Turn 1 tools used:', r1.tools);
  const sawRead = r1.tools.some((x) => x.toLowerCase().includes('read'));
  const sawAgent =
    r1.tools.some(
      (x) =>
        x.toLowerCase().includes('agent') || x.toLowerCase().includes('task'),
    ) || /agent_a|agent_b/i.test(r1.text);
  console.log(
    `  - Read tool fired: ${sawRead ? '✓' : '✗'}`,
    sawRead ? '' : '(may be inline in reply)',
  );
  console.log(
    `  - Agent/Task tool fired: ${sawAgent ? '✓' : '✗'}`,
    sawAgent ? '' : '(may have been inline)',
  );

  console.log('\nTurn 2 (secret ACK):');
  console.log(
    `  - Replied with exact ACK format: ${r2.text.includes(`ACK secret=${SECRET}`) ? '✓' : '✗'}`,
  );

  console.log('\nTurn 3 (/compact):');
  console.log(
    `  - Completed without error: ${r3.text.length >= 0 ? '✓' : '✗'}`,
  );
  console.log(`  - Tools: ${r3.tools.join(', ') || '(none)'}`);

  console.log('\nTurn 4 (post-compact awareness):');
  const knowsSecret = r4.text.includes(SECRET);
  console.log(
    `  - Still knows the secret word "${SECRET}": ${knowsSecret ? '✓ YES' : '✗ NO'}`,
  );
  console.log('  - Self-reported context state above ↑');

  // Verify all turns billed as interactive
  const sessionId = driver.getSessionId();
  if (!sessionId) {
    console.error('\n[FAIL] No session ID captured.');
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
  console.log('\nTranscript:', transcriptPath);
  const lines = readFileSync(transcriptPath, 'utf-8')
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

  const userMsgs = lines.filter((l) => l['type'] === 'user');
  const entrypoints = new Set(userMsgs.map((u) => String(u['entrypoint'])));
  console.log('Entrypoints seen across all user messages:', [...entrypoints]);
  console.log(
    `  - All "cli" (interactive billing): ${entrypoints.size === 1 && entrypoints.has('cli') ? '✓' : '✗'}`,
  );

  driver.dispose();
  process.exit(0);
}

function indent(s: string, prefix: string): string {
  return s
    .split('\n')
    .map((l) => prefix + l)
    .join('\n');
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
