/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// AUDITARIA: Native session adapters shared by slash commands and startup flags.
import {
  listClaudeSessions,
  validateClaudeSessionId,
} from './claude/claudeSessionBrowser.js';
import { loadClaudeSessionAsContent } from './claude/claudeSessionLoader.js';
import {
  listCodexSessions,
  validateCodexSessionId,
} from './codex/codexSessionBrowser.js';
import { loadCodexSessionAsContent } from './codex/codexSessionLoader.js';

export interface ExternalSessionInfo {
  sessionId: string;
  firstPrompt: string;
  timestamp: Date;
  fileSize: number;
  filePath: string;
}

export const externalSessionProviders = {
  claude: {
    name: 'Claude',
    type: 'claude-cli',
    list: listClaudeSessions,
    validate: validateClaudeSessionId,
    load: loadClaudeSessionAsContent,
  },
  codex: {
    name: 'Codex',
    type: 'codex-cli',
    list: listCodexSessions,
    validate: validateCodexSessionId,
    load: loadCodexSessionAsContent,
  },
} as const;

export type ResumableExternalProvider = keyof typeof externalSessionProviders;
