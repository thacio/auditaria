/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 *
 * One scenario, max visibility: PTY raw, tool_result content, transcript dump.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ClaudeCLIDriver } from '../packages/core/src/providers/claude/claudeCLIDriver.js';
import { ProviderEventType } from '../packages/core/src/providers/types.js';

function encodeProjectPath(p: string): string {
  return p.replace(/[:\\/]/g, '-');
}

const PROMPT = `Use your AskUserQuestion tool. The question is "Pick a color." with 4 options labelled Red, Green, Blue, Yellow (in that order).

After I answer, reply with the SINGLE word I picked, uppercase, nothing else.

Do not skip the tool call. Do not invent my answer.`;

async function main() {
  console.log('=== AskUserQuestion deep probe ===\n');

  const driver = new ClaudeCLIDriver({
    model: 'sonnet',
    cwd: process.cwd(),
    permissionMode: 'bypassPermissions',
  });

  const controller = new AbortController();
  setTimeout(() => controller.abort(), 90_000);

  const start = Date.now();
  let textOutput = '';
  let toolResultOutput = '';

  try {
    for await (const event of driver.sendMessage(PROMPT, controller.signal)) {
      const ms = Date.now() - start;
      const type = (event as { type: string }).type;
      if (type === ProviderEventType.ToolUse) {
        const name = (event as { toolName: string }).toolName;
        const input = (event as { input: Record<string, unknown> }).input;
        console.log(`[+${(ms / 1000).toFixed(1)}s] ToolUse: ${name}`);
        console.log(`  input: ${JSON.stringify(input).slice(0, 800)}`);
        if (name === 'AskUserQuestion') {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const pty = (driver as any).activePty as {
            write(d: string): void;
            pid: number;
          } | null;
          if (!pty) {
            console.log('  ! NO activePty available');
            continue;
          }
          // Wait for picker to render
          setTimeout(() => {
            try {
              // Try: down arrow twice (Red→Green→Blue), then Enter to pick Blue
              const seq = '\x1b[B\x1b[B\r';
              pty.write(seq);
              console.log(`  ! wrote ${JSON.stringify(seq)} to PTY`);
            } catch (e) {
              console.error('  pty.write threw:', e);
            }
          }, 2000);
        }
      } else if (type === ProviderEventType.ToolResult) {
        const output = (event as { output: string; isError?: boolean }).output;
        toolResultOutput = output;
        console.log(`[+${(ms / 1000).toFixed(1)}s] ToolResult:`);
        console.log(`  output: ${JSON.stringify(output).slice(0, 500)}`);
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
    console.log('\nDisposing driver...');
    driver.dispose();
  }

  console.log('\n--- Final ---');
  console.log('Reply text:', JSON.stringify(textOutput));
  console.log('Tool result:', JSON.stringify(toolResultOutput).slice(0, 400));

  // Read the transcript for the last user session
  const sessionId = driver.getSessionId();
  if (sessionId) {
    const transcriptPath = join(
      homedir(),
      '.claude',
      'projects',
      encodeProjectPath(process.cwd()),
      `${sessionId}.jsonl`,
    );
    console.log(`\nTranscript path: ${transcriptPath}`);
    try {
      const content = readFileSync(transcriptPath, 'utf-8');
      const lines = content.split('\n').filter((l) => l.trim());
      console.log(`Transcript has ${lines.length} lines.\n`);
      // Show last 5 lines for tool result detail
      for (const line of lines.slice(-5)) {
        const obj = JSON.parse(line);
        console.log(`  type=${obj.type}`);
        if (obj.message?.content) {
          const text = JSON.stringify(obj.message.content).slice(0, 600);
          console.log(`    content: ${text}`);
        }
      }
    } catch (e) {
      console.error('Transcript read failed:', e);
    }
  }

  process.exit(0);
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
