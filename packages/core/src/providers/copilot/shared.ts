/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// AUDITARIA_COPILOT_PROVIDER: Helpers shared by the ACP driver
// (copilotCLIDriver.ts) and the interactive PTY driver (copilotPtyDriver.ts):
// AGENTS.md system-context injection, MCP bridge config file, and Copilot
// executable resolution.

import {
  writeFileSync,
  readFileSync,
  mkdirSync,
  existsSync,
  unlinkSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { resolveExecutable } from '../../utils/shell-utils.js';

// ---------------------------------------------------------------------------
// System context injection via AGENTS.md
// Copilot reads AGENTS.md as custom instructions. We inject/update a marked
// section with our system context (audit context, memory, skills).
// ---------------------------------------------------------------------------

const AGENTS_MD_START = '##### AUDITARIA SYSTEM PROMPT CONTEXT';
const AGENTS_MD_END = '##### END OF AUDITARIA SYSTEM PROMPT CONTEXT';

/**
 * Inject or update our marked section in `<cwd>/AGENTS.md`.
 * - If file doesn't exist → create with just our section
 * - If markers exist → replace content between them (only if changed)
 * - If no markers → append section at end
 */
export function injectAgentsMd(cwd: string, systemContext: string): void {
  const filePath = join(cwd, 'AGENTS.md');
  try {
    let existing = '';
    try {
      existing = readFileSync(filePath, 'utf-8');
    } catch {
      // File doesn't exist — will create
    }

    const startIdx = existing.indexOf(AGENTS_MD_START);
    const endIdx = existing.indexOf(AGENTS_MD_END);

    if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
      const currentContent = existing.slice(
        startIdx + AGENTS_MD_START.length + 1,
        endIdx - 1,
      );
      if (currentContent === systemContext) return; // Already up to date

      const before = existing.slice(0, startIdx);
      const after = existing.slice(endIdx + AGENTS_MD_END.length);
      const section = `${AGENTS_MD_START}\n${systemContext}\n${AGENTS_MD_END}`;
      writeFileSync(filePath, before + section + after, 'utf-8');
    } else if (existing.trim()) {
      const section = `${AGENTS_MD_START}\n${systemContext}\n${AGENTS_MD_END}`;
      writeFileSync(
        filePath,
        existing.trimEnd() + '\n\n' + section + '\n',
        'utf-8',
      );
    } else {
      const section = `${AGENTS_MD_START}\n${systemContext}\n${AGENTS_MD_END}`;
      writeFileSync(filePath, section + '\n', 'utf-8');
    }
  } catch {
    // Best-effort — Copilot still works without the injected context.
  }
}

/** Remove our marked section from AGENTS.md (dispose-time cleanup, optional). */
export function removeAgentsMdSection(cwd: string): void {
  try {
    const filePath = join(cwd, 'AGENTS.md');
    const existing = readFileSync(filePath, 'utf-8');
    const startIdx = existing.indexOf(AGENTS_MD_START);
    const endIdx = existing.indexOf(AGENTS_MD_END);
    if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) return;
    const before = existing.slice(0, startIdx);
    const after = existing.slice(endIdx + AGENTS_MD_END.length);
    const cleaned = (before + after).replace(/\n{3,}/g, '\n\n').trim();
    if (cleaned) {
      writeFileSync(filePath, cleaned + '\n', 'utf-8');
    } else {
      unlinkSync(filePath);
    }
  } catch {
    // Best-effort cleanup (file may not exist)
  }
}

// ---------------------------------------------------------------------------
// MCP config via --additional-mcp-config @filepath
// Writes JSON to ~/.auditaria/copilot-mcp-{port}.json, passes @path to CLI.
// Port in filename prevents conflicts between parallel Auditaria instances.
// (PowerShell mangles raw JSON in args, so @filepath is required on Windows.)
// ---------------------------------------------------------------------------

export interface CopilotMcpBridgeConfig {
  toolBridgePort?: number;
  toolBridgeScript?: string;
  toolBridgeExclude?: string[];
}

export function buildMcpConfigArg(
  config: CopilotMcpBridgeConfig,
): string | undefined {
  const hasBridge = config.toolBridgePort && config.toolBridgeScript;
  if (!hasBridge) return undefined;

  const nodePath = process.execPath;
  const scriptPath = config.toolBridgeScript!;
  const port = config.toolBridgePort!;

  const bridgeArgs = [scriptPath, '--port', String(port)];
  if (config.toolBridgeExclude?.length) {
    for (const name of config.toolBridgeExclude) {
      bridgeArgs.push('--exclude', name);
    }
  }

  const mcpConfig = {
    mcpServers: {
      auditaria_tools: {
        command: nodePath,
        args: bridgeArgs,
      },
    },
  };

  // Write to file only if content changed, return @filepath reference.
  const dir = join(homedir(), '.auditaria');
  const filePath = join(dir, `copilot-mcp-${port}.json`);
  const newContent = JSON.stringify(mcpConfig, null, 2);

  let needsWrite = true;
  try {
    if (
      existsSync(filePath) &&
      readFileSync(filePath, 'utf-8') === newContent
    ) {
      needsWrite = false;
    }
  } catch {
    /* missing or unreadable — write */
  }

  if (needsWrite) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(filePath, newContent);
  }
  return `@${filePath}`;
}

// ---------------------------------------------------------------------------
// Executable resolution
// npm installs `copilot` as a .cmd shim that runs `node npm-loader.js`, which
// spawnSync's the real platform binary. Spawning the .cmd inside a PTY wraps
// everything in cmd.exe (breaks raw-mode focus, survives kills); resolve the
// real exe instead:
//   <shim dir>/node_modules/@github/copilot/node_modules/
//     @github/copilot-<platform>-<arch>/copilot(.exe)
// Falls back to the shim if the layout changes.
// ---------------------------------------------------------------------------

export function resolveCopilotExecutable(): string | undefined {
  const shim = resolveExecutable('copilot');
  if (!shim) return undefined;
  if (process.platform !== 'win32') return shim;
  if (!shim.toLowerCase().endsWith('.cmd')) return shim;

  const shimDir = dirname(shim);
  const platformPkg = `copilot-${process.platform}-${process.arch}`;
  const candidates = [
    join(
      shimDir,
      'node_modules',
      '@github',
      'copilot',
      'node_modules',
      '@github',
      platformPkg,
      'copilot.exe',
    ),
    join(
      shimDir,
      'node_modules',
      '@github',
      'copilot',
      'node_modules',
      '@github',
      platformPkg,
      'copilot',
    ),
  ];
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) return candidate;
    } catch {
      /* keep looking */
    }
  }
  return shim;
}
