/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { classifyCodexScreen } from './codexPtyDriver.js';

// Screens captured from Codex CLI 0.153.4 (scratchpad codex-probes), stripped.
const INPUT = `╭──────────────────────────────╮
│ >_ OpenAI Codex (v0.153.4)     │
│ model: gpt-5.3-codex-spark     │
╰──────────────────────────────╯
› Ask Codex to do anything
? for shortcuts`;
const TRUST = `> You are in C:\\wd
Do you trust the contents of this directory? Working with untrusted contents comes with higher risk of prompt injection.
› 1. Yes, continue
  2. No, quit
Press enter to continue`;
const MIGRATION = `GPT-5.4 Mini will be deprecated soon
Codex now uses GPT-5.6 Luna in place of GPT-5.4 Mini. Switch to GPT-5.6 Luna to continue.
› 1. Try new model
  2. Use existing model
Use ↑/↓ to move, press enter to confirm`;
const APPROVAL = `• Running echo hello > probe-approval.txt
Would you like to run the following command?
$ echo hello > probe-approval.txt
› 1. Yes, proceed (y)
  2. Yes, and don't ask again for commands that start with \`echo hello\`
  3. No, and tell Codex what to do differently (esc)`;
const PICKER = `/model choose what model and reasoning effort to use
Select Model and Effort
1. gpt-6-astra (default)
› 7. gpt-5.3-codex-spark (current)
Press enter to confirm or esc to go back`;
const WORKING = `• Running the requested command now and waiting for it to finish.
◦ Working (3s • esc to interrupt)
› Ask Codex to do anything`;

describe('classifyCodexScreen', () => {
  it('recognises the idle input prompt', () => {
    expect(classifyCodexScreen(INPUT)).toBe('input');
  });
  it('recognises the dialogs a human must answer before typing', () => {
    expect(classifyCodexScreen(TRUST)).toBe('trust');
    expect(classifyCodexScreen(MIGRATION)).toBe('migration');
    expect(
      classifyCodexScreen(
        'Approaching rate limits Switch to gpt-5.6-luna for lower credit usage? › 1. Switch to gpt-5.6-luna 2. Keep current model',
      ),
    ).toBe('migration');
    expect(classifyCodexScreen(APPROVAL)).toBe('approval');
    expect(classifyCodexScreen(PICKER)).toBe('picker');
  });
  it('a running turn is "working", not input, even though the input box is drawn', () => {
    expect(classifyCodexScreen(WORKING)).toBe('working');
  });
  it('a TUI still loading (model/directory, MCP boot) is "starting" even with the composer drawn', () => {
    expect(
      classifyCodexScreen(`│ model: loading /model to change │
│ directory: loading │
› Ask Codex to do anything`),
    ).toBe('starting');
    expect(
      classifyCodexScreen(`• Booting MCP server: auditaria-tools (0s • esc to interrupt)
› Ask Codex to do anything`),
    ).toBe('starting');
  });
});
