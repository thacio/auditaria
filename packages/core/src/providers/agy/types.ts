/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 *
 * AUDITARIA_AGY_PROVIDER: Types for the Google Antigravity CLI (`agy`) driver.
 *
 * agy is a TUI-only Go binary: `--print` produces no stdout without a real TTY,
 * and it has no JSON streaming mode. We drive it through a PTY and read its
 * structured JSONL transcript for the response (terminal scrape is a fallback).
 */

import type { ExternalMCPServerConfig } from '../types.js';

/**
 * One line of agy's transcript JSONL, written to
 * `~/.gemini/antigravity-cli/brain/<cascadeId>/.system_generated/logs/transcript.jsonl`.
 * Schema validated against 726 real transcripts (2026-06-16).
 */
export interface AgyTranscriptEntry {
  step_index: number;
  /** USER_EXPLICIT | SYSTEM | MODEL */
  source: string;
  /**
   * USER_INPUT | CONVERSATION_HISTORY | SYSTEM_MESSAGE | PLANNER_RESPONSE |
   * LIST_DIRECTORY | VIEW_FILE | RUN_COMMAND | ... (tool-result types).
   */
  type: string;
  /** DONE | RUNNING */
  status?: string;
  created_at?: string;
  /** Reply text (PLANNER_RESPONSE) or tool output (tool-result steps). */
  content?: string;
  /** Model reasoning (PLANNER_RESPONSE only). */
  thinking?: string;
  /** Tool invocations the model decided to make this step. */
  tool_calls?: Array<{
    name: string;
    args?: Record<string, unknown>;
  }>;
  truncated_fields?: string[];
}

/** Driver configuration for the agy provider. */
export interface AgyDriverConfig {
  /** Terse model id (e.g. 'gemini-3.5-flash-low'); undefined → agy default. */
  model?: string;
  cwd: string;
  /** User MCP servers to expose to agy (merged into its global mcp_config.json). */
  mcpServers?: Record<string, ExternalMCPServerConfig>;
  /** Auditaria tool-bridge (stdio MCP) — port of the ToolExecutorServer. */
  toolBridgePort?: number;
  /** Path to the node bundle that runs the MCP↔HTTP bridge. */
  toolBridgeScript?: string;
  /** Tool names to hide from the bridge (sub-agent recursion / consult mode). */
  toolBridgeExclude?: string[];
  /** Unique id for an isolated system-prompt file (sub-agents only). */
  promptFileId?: string;
}
